import { createTool } from "@mastra/core/tools";
import { makeW2FactKey, type W2FactValue } from "@openreturn/engine/facts";
import { z } from "zod";
import type { Scope } from "../db/appDb";
import { recordFact } from "../db/taxFacts";
import { cadeRequestContextSchema } from "../server/requestContext";
import { requireUserContext } from "./userContext";

const AddressSchema = z.object({
  line1: z.string(),
  line2: z.string().optional(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
});

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function toW2FactValue(input: {
  employer: { name: string; ein: string; address?: W2FactValue["employerAddress"] };
  employee?: W2FactValue["employee"];
  box1: number;
  box2: number;
  box3?: number;
  box4?: number;
  box5?: number;
  box6?: number;
  box7?: number;
  box8?: number;
  box10?: number;
  box11?: number;
  box12?: W2FactValue["box12"];
  box13?: W2FactValue["box13"];
  box14?: W2FactValue["box14"];
  box15: string;
  box16: number;
  box17: number;
}): W2FactValue {
  return {
    employerName: input.employer.name,
    employerEin: input.employer.ein,
    employerAddress: input.employer.address,
    employee: input.employee,
    box1: input.box1,
    box2: input.box2,
    box3: input.box3,
    box4: input.box4,
    box5: input.box5,
    box6: input.box6,
    box7: input.box7,
    box8: input.box8,
    box10: input.box10,
    box11: input.box11,
    box12: input.box12,
    box13: input.box13,
    box14: input.box14,
    box15: input.box15,
    box16: input.box16,
    box17: input.box17,
  };
}

export const ingestW2 = createTool({
  id: "ingest-w2-structured",
  requestContextSchema: cadeRequestContextSchema,
  description:
    "Ingest a single W-2 as a structured tax fact. Cade (or whatever upstream extractor) reads the W-2 PDF and calls this with all the box values. Writes ONE tax_facts row with the full W-2 data; the Form Engine reads it via the fact catalog. Call once per W-2.",
  inputSchema: z.object({
    year: z.number().int(),
    employer: z.object({
      name: z.string(),
      ein: z.string(),
      address: AddressSchema.optional(),
    }),
    employee: z
      .object({
        firstName: z.string().describe("From W-2 box e (employee first name)"),
        middleInitial: z.string().optional(),
        lastName: z.string().describe("From W-2 box e (employee last name)"),
        suffix: z.string().optional(),
        ssn: z.string().describe("From W-2 box a (employee SSN, formatted ###-##-####)"),
        address: AddressSchema.optional().describe("From W-2 box f (employee mailing address)"),
      })
      .optional()
      .describe(
        "Employee identity from boxes a, e, and f of the W-2. Pass this whenever you can read it from the W-2 — the tool will also write identity.name.first / identity.name.last / identity.ssn and the per-line address sub-facts (identity.address.street, .apt, .city, .state, .zip) so the form renderers can fill the personal-information boxes at the top of every form.",
      ),
    employerSlug: z
      .string()
      .optional()
      .describe(
        "Stable slug for this employer in the fact key. Defaults to slugified employer name; falls back to ein-based slug if name doesn't slugify cleanly.",
      ),
    box1: z.number().describe("Wages, tips, other compensation"),
    box2: z.number().describe("Federal income tax withheld"),
    box3: z.number().describe("Social security wages"),
    box4: z.number().describe("Social security tax withheld"),
    box5: z.number().describe("Medicare wages and tips"),
    box6: z.number().describe("Medicare tax withheld"),
    box7: z.number().optional().describe("Social security tips"),
    box8: z.number().optional().describe("Allocated tips"),
    box10: z.number().optional().describe("Dependent care benefits"),
    box11: z.number().optional().describe("Nonqualified plans"),
    box12: z
      .array(z.object({ code: z.string(), amount: z.number() }))
      .optional()
      .describe("Box 12 entries, each with an IRS code letter and dollar amount"),
    box13: z
      .object({
        statutoryEmployee: z.boolean().optional(),
        retirementPlan: z.boolean().optional(),
        thirdPartySickPay: z.boolean().optional(),
      })
      .optional()
      .describe(
        "Box 13 checkboxes: set true for each box marked with an X (statutory employee, retirement plan, third-party sick pay)",
      ),
    box14: z
      .array(z.object({ label: z.string(), amount: z.number() }))
      .optional()
      .describe("Box 14 'Other' entries — employer-specific (e.g., CA SDI)"),
    box15: z.string().describe("State (two-letter abbreviation)"),
    box16: z.number().describe("State wages"),
    box17: z.number().describe("State income tax withheld"),
    sourceNote: z.string().default("W-2 ingested via structured payload"),
  }),
  outputSchema: z.object({
    factsWritten: z.number(),
    employerSlug: z.string(),
    factKey: z.string(),
  }),
  execute: async (input, context) => {
    const { scope, userId, filingId } = await requireUserContext(context);
    const { year, sourceNote } = input;
    const slug =
      input.employerSlug ||
      slugify(input.employer.name) ||
      `ein-${input.employer.ein.replace(/-/g, "")}`;

    const w2 = toW2FactValue(input);

    const factKey = makeW2FactKey(slug);
    await recordFact(scope, {
      id: crypto.randomUUID(),
      userId,
      filingId,
      taxYear: year,
      category: "wages",
      key: factKey,
      value: w2,
      sourceNote,
    });
    const identityWrites = input.employee
      ? await writeIdentityFacts({
          scope,
          userId,
          filingId,
          year,
          employerName: input.employer.name,
          employee: input.employee,
        })
      : 0;

    return { factsWritten: 1 + identityWrites, employerSlug: slug, factKey };
  },
});

/* The latest write wins, so a later user-stated correction supersedes these. */
async function writeIdentityFacts(opts: {
  scope: Scope;
  userId: string;
  filingId: string;
  year: number;
  employerName: string;
  employee: {
    firstName?: string;
    lastName?: string;
    ssn?: string;
    address?: { line1?: string; line2?: string; city?: string; state?: string; zip?: string };
  };
}): Promise<number> {
  const { scope, userId, filingId, year, employerName, employee: e } = opts;
  let written = 0;
  const writeIdentity = async (key: string, value: unknown) => {
    if (value === undefined || value === null || value === "") return;
    await recordFact(scope, {
      id: crypto.randomUUID(),
      userId,
      filingId,
      taxYear: year,
      category: "identity",
      key,
      value,
      sourceNote: `Auto-extracted from W-2 (${employerName})`,
    });
    written++;
  };
  await writeIdentity("identity.name.first", e.firstName);
  await writeIdentity("identity.name.last", e.lastName);
  await writeIdentity("identity.ssn", e.ssn);
  /* One fact per address part: each form field binds to its own sub-fact. */
  if (e.address) {
    await writeIdentity("identity.address.street", e.address.line1);
    await writeIdentity("identity.address.apt", e.address.line2);
    await writeIdentity("identity.address.city", e.address.city);
    await writeIdentity("identity.address.state", e.address.state);
    await writeIdentity("identity.address.zip", e.address.zip);
  }
  return written;
}
