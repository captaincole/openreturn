import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, it } from "vitest";
import type { CadeRequestContext } from "../../../../src/mastra/server/requestContext";
import { ingest1099B } from "../../../../src/mastra/tools/ingest1099B.js";

describe("ingest-1099-b", () => {
  /* A call with no sales must not reach the DB at all: the identity is there, no filing is looked up. */
  it("writes nothing for an empty trades list", async () => {
    const execute = ingest1099B.execute as (input: unknown, context: unknown) => Promise<unknown>;
    const result = await execute(
      {
        year: 2025,
        payer: { name: "Example Broker", tin: "00-0000002" },
        accountNumber: "EXB-1",
        form: "1099-B",
        trades: [],
      },
      {
        requestContext: new RequestContext<CadeRequestContext>([
          ["userId", "owner-test"],
          ["userEmail", "owner@example.test"],
        ]),
      },
    );
    expect(result).toEqual({
      accountSlug: "example-broker",
      factsWritten: 0,
      decisionsWritten: 0,
      tradeIds: [],
    });
  });
});
