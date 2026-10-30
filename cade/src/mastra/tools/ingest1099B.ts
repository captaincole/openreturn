import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { cadeRequestContextSchema } from "../server/requestContext";
import { accountSlugFor, statementContext, statementFields } from "./ingestShared";
import { ingestTrades, TradeInputSchema } from "./ingestTrades";

/*
 * Past about 20 trades, local models broke the call's nesting about half the time.
 * Trade ids come from each sale's content, so repeated calls add up without collisions.
 */

export const MAX_TRADES_PER_CALL = 20;

export const ingest1099B = createTool({
  id: "ingest-1099-b",
  requestContextSchema: cadeRequestContextSchema,
  description: `Ingest the sales on a 1099-B (standalone, or the 1099-B section of a consolidated statement) or a 1099-DA. Pass at most ${MAX_TRADES_PER_CALL} sales per call. For more, call again with the next ${MAX_TRADES_PER_CALL} and the same payer and accountSlug; each call adds to the earlier ones.`,
  inputSchema: z.object({
    ...statementFields,
    form: z
      .enum(["1099-B", "1099-DA"])
      .describe(
        "1099-DA for digital asset sales; the tool then answers the 1040 digital asset question (Yes).",
      ),
    trades: z
      .array(TradeInputSchema)
      .describe(`One entry per sale, at most ${MAX_TRADES_PER_CALL} per call.`),
  }),
  outputSchema: z.object({
    accountSlug: z.string(),
    factsWritten: z.number(),
    decisionsWritten: z.number(),
    tradeIds: z.array(z.string()),
  }),
  execute: async (input, context) => {
    /* No sales: write nothing, so has_reportable_sales stays unrecorded. */
    if (input.trades.length === 0)
      return {
        accountSlug: accountSlugFor(input),
        factsWritten: 0,
        decisionsWritten: 0,
        tradeIds: [],
      };
    const { ctx, slug } = await statementContext(input, context, input.form);
    const { tradeIds, decisionsWritten } = await ingestTrades(
      ctx,
      slug,
      input.trades,
      input.payer.name,
      { digitalAsset: input.form === "1099-DA" },
    );
    return { accountSlug: slug, factsWritten: tradeIds.length, decisionsWritten, tradeIds };
  },
});
