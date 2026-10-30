import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import type { Context } from "hono";
import { addAskTurn, createAskThread, getAskThread } from "../../db/askThreads";
import { askTurnWorkflow } from "../../workflows/askTurn";

const MAX_QUESTION_CHARS = 2000;

function callerOf(c: Context): string | undefined {
  return c.get("requestContext")?.get(MASTRA_RESOURCE_ID_KEY) as string | undefined;
}

async function readQuestion(c: Context): Promise<string | null> {
  const body = (await c.req.json().catch(() => ({}))) as { question?: unknown };
  const q = typeof body.question === "string" ? body.question.trim() : "";
  return q && q.length <= MAX_QUESTION_CHARS ? q : null;
}

/* Start the run and return; the workflow's onError marks the turn failed if it dies. */
async function startTurn(userId: string, threadId: string, turnId: string): Promise<void> {
  const run = await askTurnWorkflow.createRun({ resourceId: userId });
  await run.startAsync({ inputData: { userId, threadId, turnId } });
}

export const createAskRoute = registerApiRoute("/app/ask", {
  method: "POST",
  handler: async (c) => {
    const userId = callerOf(c);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const question = await readQuestion(c);
    if (!question) return c.json({ error: "question required" }, 400);

    const { threadId, turnId } = await createAskThread(userId, question);
    await startTurn(userId, threadId, turnId);
    return c.json({ threadId, turnId });
  },
});

export const addAskTurnRoute = registerApiRoute("/app/ask/:threadId/turns", {
  method: "POST",
  handler: async (c) => {
    const userId = callerOf(c);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const question = await readQuestion(c);
    if (!question) return c.json({ error: "question required" }, 400);

    const threadId = c.req.param("threadId");
    const result = await addAskTurn(userId, threadId, question);
    if ("error" in result) {
      return result.error === "busy"
        ? c.json({ error: "a question is still being answered" }, 409)
        : c.json({ error: "not found" }, 404);
    }
    await startTurn(userId, threadId, result.turnId);
    return c.json({ threadId, turnId: result.turnId });
  },
});

export const getAskThreadRoute = registerApiRoute("/app/ask/:threadId", {
  method: "GET",
  handler: async (c) => {
    const userId = callerOf(c);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const thread = await getAskThread(userId, c.req.param("threadId"));
    if (!thread) return c.json({ error: "not found" }, 404);
    return c.json(thread);
  },
});
