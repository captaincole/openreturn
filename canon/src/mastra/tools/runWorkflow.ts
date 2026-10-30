import { createTool } from "@mastra/core/tools";
import type { Workflow } from "@mastra/core/workflows";
import { z } from "zod";

/*
 * One MCP tool per workflow, carrying the workflow's output schema.
 *
 * MCPServer can serve a workflow by itself (`workflows:`), but that tool
 * has no output schema: the run envelope travels as JSON text and every
 * client has to unwrap it. A tool with an outputSchema sends the value
 * as structuredContent, which the client validates against the schema
 * the server advertised and hands back as the typed object. The name
 * stays run_<workflow id>, so clients see the same tools as before.
 *
 * The result is `{ result: <run result> }`. MCP wants an object at the
 * root of an output schema, and Mastra advertises a non-object schema
 * (our run results are unions) wrapped exactly this way, but sends the
 * value as is; returning the wrapper ourselves keeps the schema and the
 * value the same thing.
 *
 * A run that does not succeed is a tool error (isError on the wire):
 * the client's failure path, not a result to parse.
 */
export function runWorkflowTool<O extends z.ZodTypeAny>(workflow: Workflow, runResult: O) {
  return createTool({
    id: `run_${workflow.id}`,
    description: workflow.description ?? `Run the ${workflow.id} workflow.`,
    inputSchema: workflow.inputSchema,
    outputSchema: z.object({ result: runResult }),
    execute: async (inputData) => {
      const run = await workflow.createRun();
      const result = await run.start({ inputData });
      if (result.status !== "success") {
        const detail = "error" in result ? errorMessage(result.error) : result.status;
        throw new Error(`${workflow.id} ${result.status}: ${detail}`);
      }
      return { result: runResult.parse(result.result) as z.infer<O> };
    },
  });
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
