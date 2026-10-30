import { MCPClient } from "@mastra/mcp";
import type { z } from "zod";
import {
  askRunResultSchema,
  groundRunResultSchema,
  type AskHistoryTurn,
  type AskRunResult,
  type GroundInput,
  type GroundRunResult,
} from "./schemas";

/*
 * The only path from Cade to Canon: no in-process import, no shared database.
 * CanonUnreachableError: the call never reached Canon or never came back, so a retry is the fix.
 * CanonToolError: Canon ran the tool and failed, so a retry likely fails again.
 * A ground call slower than CANON_TIMEOUT_MS needs fewer iterations, not a higher cap.
 */

export class CanonUnreachableError extends Error {
  readonly name = "CanonUnreachableError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class CanonToolError extends Error {
  readonly name = "CanonToolError";
}

export function isCanonUnreachable(err: unknown): boolean {
  for (let e = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { name?: string }).name === "CanonUnreachableError") return true;
  }
  return false;
}

const DEFAULT_URL = "http://127.0.0.1:4112";
const DEFAULT_TIMEOUT_MS = 300_000;

type CanonTool = { execute?: (input: unknown, context?: never) => Promise<unknown> };

let client: MCPClient | undefined;
let tools: Promise<Record<string, CanonTool>> | undefined;

/* Env is read at first use, not at import: dotenv may load after this module. */
function getClient(): MCPClient {
  if (client) return client;
  const token = process.env.CANON_API_TOKEN;
  client = new MCPClient({
    id: "cade-canon",
    servers: {
      canon: {
        url: new URL("/api/mcp/canon/mcp", process.env.CANON_URL ?? DEFAULT_URL),
        timeout: Number(process.env.CANON_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
        enableServerLogs: false,
        /*
         * A tool failure arrives as the result (isError + content), not as
         * a throw. A throw means Canon was not reached; a failed result
         * means it ran and failed. toolErrorText below reads the result.
         */
        onToolError: "return",
        ...(token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}),
      },
    },
  });
  return client;
}

export const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  const m = (err as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : String(err);
};

/*
 * A failed fetch is not cached, so the next call tries Canon again. MCPClient does not
 * throw when a server is down: the errors map is what says "unreachable".
 */
async function canonTool(name: string): Promise<CanonTool> {
  tools ??= getClient()
    .listToolsetsWithErrors()
    .then(({ toolsets, errors }) => {
      const canon = toolsets.canon as Record<string, CanonTool> | undefined;
      if (errors.canon || !canon) {
        throw new CanonUnreachableError(
          `Canon is not reachable: ${errors.canon ?? "no tools listed"}`,
        );
      }
      return canon;
    })
    .catch((err: unknown) => {
      tools = undefined;
      if (isCanonUnreachable(err)) throw err;
      throw new CanonUnreachableError(`Canon is not reachable: ${errorMessage(err)}`, {
        cause: err,
      });
    });
  const tool = (await tools)[name];
  if (!tool?.execute) throw new CanonToolError(`Canon has no tool "${name}"`);
  return tool;
}

type McpResult = { isError?: boolean; content?: { type?: string; text?: string }[] };

function toolErrorText(raw: unknown): string | null {
  const r = raw as McpResult | null;
  if (!r?.isError) return null;
  return r.content?.map((c) => c.text ?? "").join("\n") || "unknown error";
}

/*
 * Canon serves its workflows as tools with output schemas
 * (canon/src/mastra/tools/runWorkflow.ts); each answers
 * `{ result: <run result> }`, the run result being the workflow's own
 * output (status ok | failed). Other tools answer their object directly.
 */
function structuredValue(name: string, raw: unknown): unknown {
  if (!name.startsWith("run_")) return raw;
  return (raw as { result?: unknown } | null)?.result;
}

export async function callCanon<S extends z.ZodTypeAny>(
  name: string,
  input: unknown,
  schema: S,
): Promise<z.infer<S>> {
  const tool = await canonTool(name);
  let raw: unknown;
  try {
    raw = await tool.execute?.(input);
  } catch (err) {
    throw new CanonUnreachableError(`Canon ${name}: ${errorMessage(err)}`, { cause: err });
  }
  const failure = toolErrorText(raw);
  if (failure) throw new CanonToolError(`Canon ${name} failed: ${failure}`);
  const parsed = schema.safeParse(structuredValue(name, raw));
  if (!parsed.success) {
    throw new CanonToolError(`Canon ${name} returned an unexpected shape: ${parsed.error.message}`);
  }
  return parsed.data;
}

export async function askCanon(input: {
  question: string;
  history: AskHistoryTurn[];
}): Promise<AskRunResult> {
  return callCanon("run_ask", input, askRunResultSchema);
}

export async function groundCanon(input: GroundInput): Promise<GroundRunResult> {
  return callCanon("run_ground", input, groundRunResultSchema);
}

export async function disconnectCanon(): Promise<void> {
  await client?.disconnect();
  client = undefined;
  tools = undefined;
}
