import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

type FakeTool = { execute: (input: unknown) => Promise<unknown> };
let fakeTools: Record<string, FakeTool> = {};
let listToolsError: Error | undefined;

/* Like MCPClient: a server that is down shows up in `errors`, not as a throw. */
vi.mock("@mastra/mcp", () => ({
  MCPClient: class {
    async listToolsetsWithErrors() {
      if (listToolsError) return { toolsets: {}, errors: { canon: listToolsError.message } };
      return { toolsets: { canon: fakeTools }, errors: {} };
    }
    async disconnect() {}
  },
}));

const { callCanon, disconnectCanon, isCanonUnreachable } =
  await import("../../../../src/mastra/canon/client");

/* What the client returns for a call the server failed (onToolError: "return"). */
const failed = (message: string) => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

afterEach(async () => {
  await disconnectCanon();
  fakeTools = {};
  listToolsError = undefined;
});

describe("callCanon", () => {
  it("parses a structured tool result", async () => {
    fakeTools = { searchRefDocs: { execute: async () => ({ results: [{ n: 1 }] }) } };
    const out = await callCanon(
      "searchRefDocs",
      { query: "q" },
      z.object({ results: z.array(z.any()) }),
    );
    expect(out.results).toHaveLength(1);
  });

  it("takes a workflow tool's run result out of its { result } object", async () => {
    fakeTools = {
      run_ground: { execute: async () => ({ result: { status: "ok", verdict: "accurate" } }) },
    };
    const out = await callCanon("run_ground", {}, z.object({ verdict: z.string() }));
    expect(out.verdict).toBe("accurate");
  });

  it("rejects a result that does not match the schema as a tool error", async () => {
    fakeTools = { run_ground: { execute: async () => ({ result: { verdict: 7 } }) } };
    const err = await callCanon("run_ground", {}, z.object({ verdict: z.string() })).catch(
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe("CanonToolError");
    expect((err as Error).message).toContain("unexpected shape");
  });

  it("reports a failed call as a tool error, not an unreachable one", async () => {
    fakeTools = {
      run_ground: { execute: async () => failed("ground failed: rule: no structured output") },
    };
    const err = await callCanon("run_ground", {}, z.unknown()).catch((e: unknown) => e);
    expect((err as Error).name).toBe("CanonToolError");
    expect((err as Error).message).toContain("rule: no structured output");
    expect(isCanonUnreachable(err)).toBe(false);
  });

  it("is unreachable when the client cannot list tools, and tries again next time", async () => {
    listToolsError = new Error("fetch failed");
    const err = await callCanon("run_ask", {}, z.unknown()).catch((e: unknown) => e);
    expect(isCanonUnreachable(err)).toBe(true);

    listToolsError = undefined;
    fakeTools = { run_ask: { execute: async () => ({ result: { ok: 1 } }) } };
    await expect(callCanon("run_ask", {}, z.object({ ok: z.number() }))).resolves.toEqual({
      ok: 1,
    });
  });

  it("is unreachable when the call itself throws", async () => {
    fakeTools = {
      run_ask: {
        execute: async () => {
          throw new Error("Request timed out");
        },
      },
    };
    const err = await callCanon("run_ask", {}, z.unknown()).catch((e: unknown) => e);
    expect(isCanonUnreachable(err)).toBe(true);
  });
});
