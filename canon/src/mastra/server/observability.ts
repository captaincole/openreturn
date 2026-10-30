import { type AnyExportedSpan, type CustomSpanFormatter } from "@mastra/core/observability";
import { ConsoleExporter, MastraStorageExporter, Observability } from "@mastra/observability";

/*
 * ConsoleExporter dumps every full span, which floods the dev terminal.
 * An allowlist (not a blocklist) also drops keys a future Mastra version
 * adds. MastraStorageExporter still stores the full trace for Studio.
 */
const ALLOW_KEYS = new Set([
  "id",
  "type",
  "name",
  "startTime",
  "endTime",
  "traceId",
  "parentSpanId",
  "isRootSpan",
  "errorInfo",
  "message",
  "stack",
  "details",
  "domain",
  "category",
  "input",
  "output",
  "messages",
  "role",
  "content",
  "text",
  "warnings",
  "reasoning",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function filter(value: unknown): unknown {
  if (Array.isArray(value)) {
    // System messages carry the multi-KB system prompt.
    return value
      .filter(
        (item) =>
          !(item && typeof item === "object" && (item as { role?: unknown }).role === "system"),
      )
      .map(filter);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!ALLOW_KEYS.has(k)) continue;
      out[k] = filter(v);
    }
    return out;
  }
  return value;
}

const formatSpan: CustomSpanFormatter = (span) => {
  return filter(span) as AnyExportedSpan;
};

export function createObservability(): Observability {
  const isDev = process.env.MASTRA_DEV === "true";
  return new Observability({
    configs: {
      default: {
        serviceName: "openreturn",
        exporters: isDev
          ? [new ConsoleExporter({ customSpanFormatter: formatSpan }), new MastraStorageExporter()]
          : [new MastraStorageExporter()],
      },
    },
  });
}
