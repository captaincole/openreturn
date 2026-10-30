import { createTool } from "@mastra/core/tools";
import {
  makeRetirementDistributionFactKey,
  type RetirementDistributionFactValue,
} from "@openreturn/engine/facts";
import { z } from "zod";
import { cadeRequestContextSchema } from "../server/requestContext";
import { PayerSchema, recordIngestFact, slugify, type IngestCtx } from "./ingestShared";
import { requireUserContext } from "./userContext";

const BoxesSchema = z.object({
  box1: z.number().describe("Gross distribution"),
  box2a: z.number().optional().describe("Taxable amount. Pass 0 when the form prints 0.00."),
  box2b: z
    .object({
      taxableAmountNotDetermined: z.boolean().optional(),
      totalDistribution: z.boolean().optional(),
    })
    .optional()
    .describe("Box 2b checkboxes"),
  box3: z.number().optional().describe("Capital gain (included in box 2a)"),
  box4: z.number().optional().describe("Federal income tax withheld"),
  box5: z.number().optional().describe("Employee contributions / designated Roth contributions"),
  box6: z.number().optional().describe("Net unrealized appreciation"),
  box7: z.string().describe("Distribution code(s) exactly as printed, e.g. '7', 'G', 'H', '4G'"),
  box7IraSepSimple: z.boolean().describe("True when the IRA/SEP/SIMPLE checkbox is checked"),
  box8: z.number().optional().describe("Other"),
  box9a: z.number().optional().describe("Your percentage of total distribution"),
  box9b: z.number().optional().describe("Total employee contributions"),
  box10: z.number().optional().describe("Amount allocable to IRR within 5 years"),
  box11: z.number().int().optional().describe("1st year of designated Roth contributions"),
  box12: z.boolean().optional().describe("FATCA filing requirement"),
  box13: z.string().optional().describe("Date of payment"),
  box14: z.number().optional().describe("State tax withheld"),
  box15: z.string().optional().describe("State / payer's state number"),
  box16: z.number().optional().describe("State distribution"),
  box17: z.number().optional().describe("Local tax withheld"),
  box18: z.string().optional().describe("Name of locality"),
  box19: z.number().optional().describe("Local distribution"),
});

export const ingest1099R = createTool({
  id: "ingest-1099-r",
  requestContextSchema: cadeRequestContextSchema,
  description:
    "Ingest one Form 1099-R (distributions from pensions, annuities, retirement plans, IRAs). Call ONCE per 1099-R form; a payer that sends two forms (e.g. code G and code H) needs two calls. Writes one fact under category 'retirement'.",
  inputSchema: z.object({
    year: z.number().int(),
    payer: PayerSchema,
    planName: z.string().optional().describe("Plan name, when printed"),
    accountNumber: z.string().optional(),
    distributionId: z
      .string()
      .optional()
      .describe(
        "Stable id for this form. Defaults to 'code-{box7}-{accountNumber or gross cents}'.",
      ),
    boxes: BoxesSchema,
    sourceNote: z.string().default("Form 1099-R ingested via structured payload"),
  }),
  outputSchema: z.object({ factKey: z.string() }),
  execute: async (input, context) => {
    const { scope, userId, filingId } = await requireUserContext(context);
    const ctx: IngestCtx = {
      scope,
      userId,
      filingId,
      year: input.year,
      sourceNote: input.sourceNote,
    };
    const payerSlug = slugify(input.payer.name) || `tin-${input.payer.tin.replace(/-/g, "")}`;
    const suffix = input.accountNumber ?? String(Math.round(input.boxes.box1 * 100));
    const distributionId = input.distributionId ?? slugify(`code-${input.boxes.box7}-${suffix}`);
    const value: RetirementDistributionFactValue = {
      payerName: input.payer.name,
      payerTin: input.payer.tin,
      planName: input.planName,
      ...input.boxes,
    };
    const factKey = makeRetirementDistributionFactKey(payerSlug, distributionId);
    await recordIngestFact(ctx, "retirement", factKey, value);
    return { factKey };
  },
});
