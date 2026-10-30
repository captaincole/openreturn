import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { askCanon } from "../../canon/client";
import type { AskHistoryTurn } from "../../canon/schemas";
import {
  completeAskTurn,
  failAskTurn,
  getAskThread,
  setAskTurnStage,
  type AskTurn,
} from "../../db/askThreads";

/* load → answer. A throw ends the run; onError marks the turn failed so the page never waits. */

export const askTurnInputSchema = z.object({
  userId: z.string(),
  threadId: z.string(),
  turnId: z.string(),
});
export type AskTurnInput = z.infer<typeof askTurnInputSchema>;

const historyTurnSchema = z.object({ question: z.string(), answer: z.string() });

const loadedTurnSchema = askTurnInputSchema.extend({
  question: z.string(),
  history: z.array(historyTurnSchema),
  /** Epoch ms when the run started: the turn's duration counts from here. */
  started: z.number(),
});

const askTurnOutputSchema = z.object({
  turnId: z.string(),
  status: z.enum(["completed", "failed"]),
});
export type AskTurnOutput = z.infer<typeof askTurnOutputSchema>;

function history(earlier: AskTurn[]): AskHistoryTurn[] {
  return earlier
    .filter((t) => t.status === "completed" && t.answer)
    .map((t) => ({ question: t.question, answer: t.answer ?? "" }));
}

const loadStep = createStep({
  id: "load",
  inputSchema: askTurnInputSchema,
  outputSchema: loadedTurnSchema,
  execute: async ({ inputData }) => {
    const thread = await getAskThread(inputData.userId, inputData.threadId);
    const turn = thread?.turns.find((t) => t.id === inputData.turnId);
    if (!thread || !turn) throw new Error(`ask turn ${inputData.turnId} not found`);
    const earlier = thread.turns.filter((t) => t.index < turn.index);
    await setAskTurnStage(turn.id, "retrieving");
    return {
      ...inputData,
      question: turn.question,
      history: history(earlier),
      started: Date.now(),
    };
  },
});

const answerStep = createStep({
  id: "answer",
  inputSchema: loadedTurnSchema,
  outputSchema: askTurnOutputSchema,
  execute: async ({ inputData: turn }) => {
    const result = await askCanon({ question: turn.question, history: turn.history });
    const durationMs = Date.now() - turn.started;
    if (result.status === "failed") {
      await failAskTurn(turn.turnId, `The answer failed: ${result.error}`, result.log, durationMs);
      return { turnId: turn.turnId, status: "failed" as const };
    }
    await completeAskTurn(turn.turnId, {
      answer: result.answer,
      coverage: result.coverage,
      citations: result.citations,
      missingDocuments: result.missingDocuments,
      log: { steps: result.log.steps },
      durationMs,
    });
    return { turnId: turn.turnId, status: "completed" as const };
  },
});

export const askTurnWorkflow = createWorkflow({
  id: "ask-turn",
  description: "One Ask The Tax Code turn: load the thread, ask Canon, record the answer.",
  inputSchema: askTurnInputSchema,
  outputSchema: askTurnOutputSchema,
  options: {
    onError: async ({ error, steps, getInitData }) => {
      const { turnId } = askTurnInputSchema.parse(getInitData());
      const loaded =
        steps.load?.status === "success" ? loadedTurnSchema.parse(steps.load.output) : null;
      const reason = error?.message ?? "unknown error";
      const durationMs = loaded ? Date.now() - loaded.started : 0;
      await failAskTurn(turnId, `The answer failed: ${reason}`, { steps: [] }, durationMs);
    },
  },
})
  .then(loadStep)
  .then(answerStep)
  .commit();
