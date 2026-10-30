import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * The ask-turn workflow around a fake Canon: a completed answer lands on
 * the turn row, a failed run result marks the turn failed with Canon's
 * log, and a throw (Canon unreachable) marks it failed from the
 * workflow's onError. app.db is a throwaway file.
 */

const dir = mkdtempSync(path.join(tmpdir(), "openreturn-ask-test-"));
process.env.APP_DB_PATH = path.join(dir, "app.db");
process.env.MASTRA_DB_PATH = path.join(dir, "mastra.db");

type AskFn = (input: unknown) => Promise<unknown>;
let ask: AskFn = async () => {
  throw new Error("no fake set");
};

vi.mock("../../../../src/mastra/canon/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../../src/mastra/canon/client")>();
  return { ...real, askCanon: (input: unknown) => ask(input) };
});

const client = await import("../../../../src/mastra/canon/client");
const threads = await import("../../../../src/mastra/db/askThreads");
const { askTurnWorkflow } = await import("../../../../src/mastra/workflows/askTurn");

const userId = "owner";

const answered = {
  status: "ok" as const,
  answer: "Yes [1].",
  coverage: "covered" as const,
  citations: [],
  missingDocuments: [],
  log: { steps: [{ kind: "answer" }] },
};

async function runTurn(question: string) {
  const { threadId, turnId } = await threads.createAskThread(userId, question);
  const run = await askTurnWorkflow.createRun({ resourceId: userId });
  const result = await run.start({ inputData: { userId, threadId, turnId } });
  const thread = await threads.getAskThread(userId, threadId);
  return { result, turn: thread?.turns.find((t) => t.id === turnId) };
}

beforeAll(async () => {
  const { Mastra } = await import("@mastra/core");
  new Mastra({ workflows: { askTurn: askTurnWorkflow } });
});

afterEach(() => {
  ask = async () => {
    throw new Error("no fake set");
  };
});

describe("askTurn workflow", () => {
  it("records the answer on the turn", async () => {
    ask = async () => answered;
    const { result, turn } = await runTurn("Is it deductible?");
    expect(result.status).toBe("success");
    expect(turn).toMatchObject({ status: "completed", answer: "Yes [1].", coverage: "covered" });
    expect(turn?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("marks the turn failed when Canon's run failed, keeping its log", async () => {
    ask = async () => ({ status: "failed", error: "answer: no output", log: { steps: [] } });
    const { result, turn } = await runTurn("Is it deductible?");
    expect(result.status).toBe("success");
    expect(turn).toMatchObject({ status: "failed", error: "The answer failed: answer: no output" });
  });

  it("marks the turn failed from onError when the call threw", async () => {
    ask = async () => {
      throw new client.CanonUnreachableError("Canon run_ask: Request timed out");
    };
    const { result, turn } = await runTurn("Is it deductible?");
    expect(result.status).toBe("failed");
    expect(turn?.status).toBe("failed");
    expect(turn?.error).toContain("Request timed out");
  });
});
