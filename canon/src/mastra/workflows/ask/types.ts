import { z } from "zod";
import type { SourceFormat } from "../../../db/corpusStore";

// Canon is stateless: Cade keeps the threads in app.db and sends `history`.
export type { SourceFormat };
export type AskCoverage = "covered" | "partial" | "not_covered";
export type AskStage = "formulating" | "retrieving" | "answering";

export interface AskCitation {
  n: number;
  blockId: string;
  docId: string;
  documentTitle: string;
  /** Missing on citations saved before HTML documents existed: read it as "pdf". */
  format?: SourceFormat;
  sectionHeading: string | null;
  pageNum: number;
  quote: string;
}

export interface AskHistoryTurn {
  question: string;
  answer: string;
}

export const askCitationSchema = z.object({
  n: z.number().int(),
  blockId: z.string(),
  docId: z.string(),
  documentTitle: z.string(),
  format: z.enum(["pdf", "html"]).optional(),
  sectionHeading: z.string().nullable(),
  pageNum: z.number(),
  quote: z.string(),
});

export const askInputSchema = z.object({
  question: z.string().min(1).max(2000).describe("The tax-code question."),
  history: z
    .array(z.object({ question: z.string(), answer: z.string() }))
    .default([])
    .describe("Completed earlier turns of the same conversation, oldest first."),
});

export const askResultSchema = z.object({
  answer: z.string(),
  coverage: z.enum(["covered", "partial", "not_covered"]),
  citations: z.array(askCitationSchema),
  missingDocuments: z.array(z.string()),
  log: z.object({ steps: z.array(z.record(z.string(), z.unknown())) }),
});

export type AskInput = z.infer<typeof askInputSchema>;
export type AskResult = z.infer<typeof askResultSchema>;

// A failure still returns the query log, so the caller keeps it.
export const askRunResultSchema = z.discriminatedUnion("status", [
  askResultSchema.extend({ status: z.literal("ok") }),
  z.object({
    status: z.literal("failed"),
    error: z.string(),
    log: z.object({ steps: z.array(z.record(z.string(), z.unknown())) }),
  }),
]);
export type AskRunResult = z.infer<typeof askRunResultSchema>;
