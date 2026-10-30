import { createTool } from "@mastra/core/tools";
import {
  makeHsaDistributionFactKey,
  type HsaDistributionFactValue,
} from "@openreturn/engine/facts";
import { z } from "zod";
import { cadeRequestContextSchema } from "../server/requestContext";
import { PayerSchema, recordIngestFact, slugify, type IngestCtx } from "./ingestShared";
import { requireUserContext } from "./userContext";

/*
 * "Paid qualified medical expenses" is a verbal fact (hsa.distributions_all_qualified).
 * Form 5498-SA is not needed: W-2 box 12 code W carries employer contributions.
 */

export const ingest1099SA = createTool({
  id: "ingest-1099-sa",
  requestContextSchema: cadeRequestContextSchema,
  description:
    "Ingest one Form 1099-SA (HSA, Archer MSA or Medicare Advantage MSA distribution). Call ONCE per form. Writes one fact under category 'hsa'. Then ask the user whether every distribution paid qualified medical expenses, if not yet known.",
  inputSchema: z.object({
    year: z.number().int(),
    payer: PayerSchema,
    accountNumber: z.string().optional(),
    accountSlug: z
      .string()
      .optional()
      .describe("Stable slug for this account. Defaults to slugified payer name."),
    box1: z.number().describe("Gross distribution"),
    box2: z.number().optional().describe("Earnings on excess contributions"),
    box3: z.string().describe("Distribution code, e.g. '1' (normal distribution)"),
    box4: z.number().optional().describe("FMV on date of death"),
    box5: z.enum(["HSA", "Archer MSA", "MA MSA"]).describe("Account type checkbox"),
    sourceNote: z.string().default("Form 1099-SA ingested via structured payload"),
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
    const slug =
      input.accountSlug || slugify(input.payer.name) || `tin-${input.payer.tin.replace(/-/g, "")}`;
    const value: HsaDistributionFactValue = {
      payerName: input.payer.name,
      payerTin: input.payer.tin,
      box1: input.box1,
      box2: input.box2,
      box3: input.box3,
      box4: input.box4,
      box5: input.box5,
    };
    const factKey = makeHsaDistributionFactKey(slug, `code-${slugify(input.box3)}`);
    await recordIngestFact(ctx, "hsa", factKey, value);
    return { factKey };
  },
});
