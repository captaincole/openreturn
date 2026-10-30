import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { listDecisions, recordDecision } from "../db/aiDecisions";
import { cadeRequestContextSchema } from "../server/requestContext";
import { enqueueReview, retryAfter } from "../workflows/reviewDecision";
import { requireUserContext } from "./userContext";

export const recordAIDecision = createTool({
  id: "record-ai-decision",
  requestContextSchema: cadeRequestContextSchema,
  description:
    "Record a judgment call the agent made that isn't a direct user-stated fact. Use when the user's situation is ambiguous or underdetermined and the agent must interpret it (e.g. 'full-year CA resident despite 3 months in NV', 'W-2 income classified as wages not self-employment'). MUST include a rationale explaining the reasoning, which facts supported it, and a confidence level. After the decision is recorded, a background review-decision workflow runs (gather facts + IRS guidance, assess risk, rule). The tool returns IMMEDIATELY with verdict='pending' — keep going. The verdict updates on the row when the review completes; an open_questions row is created if more facts are needed.",
  inputSchema: z.object({
    year: z.number().int().describe("Tax year (e.g. 2025)"),
    decisionKey: z
      .string()
      .describe(
        "Stable decision identifier, dotted snake_case. Prefix with 'decisions.' (e.g. 'decisions.ca_residency', 'decisions.filing_status_eligibility'). This key is how downstream derivations reference the decision.",
      ),
    decision: z
      .any()
      .describe(
        "The decision value — string, number, boolean, or object. Use the narrowest shape that captures the call (e.g. 'full_year_resident', true, {status:'single'}).",
      ),
    rationale: z
      .string()
      .describe(
        "The 'why' — plain-English reasoning that a CPA could audit. Reference the facts you relied on and why the alternative was rejected.",
      ),
    supportingFactKeys: z
      .array(z.string())
      .describe(
        "List of fact_keys (from tax_facts) that informed this decision. Lets a reviewer trace the decision back to its grounding facts.",
      ),
    confidence: z
      .enum(["low", "medium", "high"])
      .describe(
        "How confident the agent is. Use 'low' when the facts are sparse or contradictory, 'high' when the rule is unambiguous and the facts fit cleanly.",
      ),
    dissentingConsiderations: z
      .string()
      .optional()
      .describe(
        "Optional — what a reasonable reviewer might push back on, or what would change the decision. Write this when confidence is low or medium.",
      ),
    sourceNote: z
      .string()
      .describe(
        "Short origin note — e.g. 'derived from intake conversation 2026-04-22' or 'after user clarified Nevada travel'.",
      ),
  }),
  outputSchema: z.object({
    id: z.string(),
    recorded: z.boolean(),
    verdict: z.literal("pending"),
    verdictReason: z.string(),
  }),
  execute: async (input, context) => {
    const { scope, userId, filingId } = await requireUserContext(context);
    const id = crypto.randomUUID();
    await recordDecision(scope, {
      id,
      userId,
      filingId,
      taxYear: input.year,
      decisionKey: input.decisionKey,
      decision: input.decision,
      rationale: input.rationale,
      supportingFactKeys: input.supportingFactKeys,
      confidence: input.confidence,
      dissentingConsiderations: input.dissentingConsiderations,
      sourceNote: input.sourceNote,
    });

    /*
     * Fire-and-forget: the wrapper stamps its own failures (review_failed / review_unreached).
     * A review that reached Canon re-queues earlier unreached ones; there is no scheduler.
     * This catch only logs unexpected throws.
     */
    // DECISION_REVIEW=off skips the review (the E2E run does this); the verdict stays "pending".
    const reviewOn = process.env.DECISION_REVIEW !== "off";
    if (reviewOn) {
      void enqueueReview(scope, id)
        .then((out) => retryAfter(scope, out))
        .catch((err) => {
          console.error(`[review-decision] background run failed for decision ${id}:`, err);
        });
    }

    return {
      id,
      recorded: true,
      verdict: "pending" as const,
      verdictReason: reviewOn
        ? "Review running in background."
        : "Review turned off (DECISION_REVIEW=off).",
    };
  },
});

export const listAIDecisions = createTool({
  id: "list-ai-decisions",
  requestContextSchema: cadeRequestContextSchema,
  description:
    "List previously recorded AI decisions for the current user. Use to review what judgment calls have been made and avoid duplicating or contradicting them.",
  inputSchema: z.object({
    year: z.number().int().optional(),
    decisionKey: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  outputSchema: z.object({
    decisions: z.array(
      z.object({
        id: z.string(),
        userId: z.string(),
        taxYear: z.number(),
        decisionKey: z.string(),
        decision: z.any(),
        rationale: z.string(),
        supportingFactKeys: z.array(z.string()),
        confidence: z.string(),
        dissentingConsiderations: z.string().nullable(),
        authorityCitations: z.any().nullable(),
        sourceNote: z.string().nullable(),
        createdAt: z.string(),
        verdict: z
          .enum([
            "pending",
            "accurate",
            "inaccurate",
            "ungroundable",
            "needs_more_facts",
            "review_failed",
            "review_unreached",
          ])
          .nullable(),
        verdictReason: z.string().nullable(),
        verdictAt: z.string().nullable(),
      }),
    ),
  }),
  execute: async (input, context) => {
    const { scope } = await requireUserContext(context);
    const decisions = await listDecisions(scope, {
      taxYear: input.year,
      decisionKey: input.decisionKey,
      limit: input.limit,
    });
    return { decisions };
  },
});
