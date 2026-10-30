import { createTool } from "@mastra/core/tools";
import {
  makeHouseholdEmployeeFactKey,
  type HouseholdEmployeeFactValue,
} from "@openreturn/engine/facts";
import { z } from "zod";
import { cadeRequestContextSchema } from "../server/requestContext";
import { recordIngestFact, slugify, type IngestCtx } from "./ingestShared";
import { requireUserContext } from "./userContext";

/* The user is the employer on this W-2 (Schedule H), so it is never a wages or identity fact. */

export const ingestHouseholdW2 = createTool({
  id: "ingest-household-w2",
  requestContextSchema: cadeRequestContextSchema,
  description:
    "Ingest one W-2 that the USER issued to their household employee (nanny, housekeeper, caregiver): the user's own name is in box c (employer). Not for the user's own W-2s (use ingest-w2-structured). Call ONCE per household employee W-2. Writes one fact under category 'household_employment' for Schedule H. Then ask whether the user paid $1,000 or more in cash wages to household employees in any calendar quarter of 2024 or 2025.",
  inputSchema: z.object({
    year: z.number().int(),
    employeeName: z.string().describe("Box e: the household employee's name"),
    employerEin: z.string().describe("Box b: the user's EIN as household employer"),
    box1: z.number().optional().describe("Wages, tips, other compensation"),
    box2: z.number().optional().describe("Federal income tax withheld"),
    box3: z.number().describe("Social security wages"),
    box4: z.number().optional().describe("Social security tax withheld"),
    box5: z.number().describe("Medicare wages and tips"),
    box6: z.number().optional().describe("Medicare tax withheld"),
    sourceNote: z.string().default("Household employee W-2 ingested via structured payload"),
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
    const value: HouseholdEmployeeFactValue = {
      employeeName: input.employeeName,
      employerEin: input.employerEin,
      box1: input.box1,
      box2: input.box2,
      box3: input.box3,
      box4: input.box4,
      box5: input.box5,
      box6: input.box6,
    };
    const factKey = makeHouseholdEmployeeFactKey(slugify(input.employeeName) || "employee");
    await recordIngestFact(ctx, "household_employment", factKey, value);
    return { factKey };
  },
});
