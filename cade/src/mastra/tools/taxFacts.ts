import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { listFacts, listOpenQuestions, recordFacts, resolveQuestion } from "../db/taxFacts";
import { cadeRequestContextSchema } from "../server/requestContext";
import { requireUserContext } from "./userContext";

const CATEGORIES = [
  "preferences",
  "identity",
  "filing_status",
  "dependents",
  "wages",
  "self_employment",
  "k1",
  "investment_income",
  "capital_gains",
  "rental",
  "retirement",
  "hsa",
  "household_employment",
  "home_energy",
  "charitable",
  "mortgage",
  "state_local_tax",
  "medical",
  "health_coverage",
  "education",
  "estimated_payments",
  "crypto",
  "foreign",
  "trust_estate",
  "use_tax",
  "other",
] as const;

/* Few enough facts per call that each call traces back to one user message. */
export const MAX_FACTS_PER_CALL = 5;

const factInput = z.object({
  category: z.enum(CATEGORIES).describe("Fact category bucket"),
  key: z.string().describe("Fact key, e.g. 'identity.occupation' or 'use_tax.owed_amount'"),
  value: z
    .any()
    .describe("The value — number, string, or object. Numbers should be in dollars unless noted."),
  sourceNote: z.string().describe("Where this came from — document, statement, or conversation"),
});

export const recordTaxFacts = createTool({
  id: "record-tax-facts",
  requestContextSchema: cadeRequestContextSchema,
  description: `Store 1 to ${MAX_FACTS_PER_CALL} confirmed tax facts for the current user/year in one call. Put every fact from the user's message in the same call; split more than ${MAX_FACTS_PER_CALL} facts into several calls. Only record a value the user has explicitly stated or confirmed — never invent or guess. Give each fact a sourceNote describing where the value came from (e.g. 'W-2 Box 1 from Stripe, 2025', 'verbal confirmation during 2026-04-19 intake'). The user is identified automatically via auth — you don't need to track an id.`,
  inputSchema: z.object({
    year: z.number().int().describe("Tax year (e.g. 2025)"),
    // No .max(): the cap is enforced in execute, with an error that says how to split.
    facts: z.array(factInput).describe(`1 to ${MAX_FACTS_PER_CALL} facts`),
  }),
  outputSchema: z.object({
    recorded: z.array(z.object({ key: z.string(), id: z.string() })),
  }),
  execute: async (input, context) => {
    const { facts, year } = input;
    if (facts.length === 0 || facts.length > MAX_FACTS_PER_CALL) {
      throw new Error(
        `record-tax-facts takes 1 to ${MAX_FACTS_PER_CALL} facts; got ${facts.length}. Nothing was recorded. Split the facts into calls of ${MAX_FACTS_PER_CALL} or fewer.`,
      );
    }
    const { scope, userId, filingId } = await requireUserContext(context);
    const rows = facts.map((f) => ({
      id: crypto.randomUUID(),
      userId,
      filingId,
      taxYear: year,
      category: f.category,
      key: f.key,
      value: f.value,
      sourceNote: f.sourceNote,
    }));
    await recordFacts(scope, rows);
    return { recorded: rows.map(({ key, id }) => ({ key, id })) };
  },
});

export const listTaxFacts = createTool({
  id: "list-tax-facts",
  requestContextSchema: cadeRequestContextSchema,
  description:
    "List previously recorded tax facts for the current user. Use before asking a question to avoid re-asking something already confirmed, and when preparing a summary.",
  inputSchema: z.object({
    year: z.number().int().optional(),
    category: z.enum(CATEGORIES).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  outputSchema: z.object({
    facts: z.array(
      z.object({
        id: z.string(),
        userId: z.string(),
        taxYear: z.number(),
        category: z.string(),
        key: z.string(),
        value: z.any(),
        sourceNote: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
  execute: async (input, context) => {
    const { scope } = await requireUserContext(context);
    const facts = await listFacts(scope, {
      taxYear: input.year,
      category: input.category,
      limit: input.limit,
    });
    return { facts };
  },
});

export const listOpenQuestionsTool = createTool({
  id: "list-open-questions",
  requestContextSchema: cadeRequestContextSchema,
  description:
    "List unresolved questions/gaps for the current user. Use at the start of a session to pick up where the last one left off, and before generating a summary.",
  inputSchema: z.object({
    status: z.enum(["open", "resolved", "all"]).optional(),
  }),
  outputSchema: z.object({
    questions: z.array(
      z.object({
        id: z.string(),
        userId: z.string(),
        status: z.string(),
        question: z.string(),
        context: z.string().nullable(),
        createdAt: z.string(),
        resolvedAt: z.string().nullable(),
      }),
    ),
  }),
  execute: async (input, ctx) => {
    const { scope } = await requireUserContext(ctx);
    const questions = await listOpenQuestions(scope, input.status ?? "open");
    return { questions };
  },
});

export const resolveOpenQuestion = createTool({
  id: "resolve-open-question",
  requestContextSchema: cadeRequestContextSchema,
  description:
    "Mark an open question as resolved once the user has answered it and the fact has been recorded.",
  inputSchema: z.object({
    id: z.string(),
  }),
  outputSchema: z.object({
    resolved: z.boolean(),
  }),
  execute: async (input, ctx) => {
    const { scope } = await requireUserContext(ctx);
    await resolveQuestion(scope, input.id);
    return { resolved: true };
  },
});
