import { Mastra } from "@mastra/core";
import "dotenv/config";
import { canonMcp } from "./mcp";
import { ConsoleLogger } from "./server/consoleLogger";
import { createObservability } from "./server/observability";
import { requestGuard } from "./server/requestGuard";
import { listRefDocsRoute, refDocHtmlRoute, refDocPdfRoute } from "./server/routes/refdocs";
import { createStorage } from "./server/storage";
import { tokenGate } from "./server/tokenGate";
import { askWorkflow } from "./workflows/ask";
import { askAnswerer } from "./workflows/ask/judges/askAnswerer";
import { askQueryFormulator } from "./workflows/ask/judges/askQueryFormulator";
import { groundWorkflow } from "./workflows/ground";
import { assessRiskAgent } from "./workflows/ground/judges/assessRiskAgent";
import { queryFormulator } from "./workflows/ground/judges/queryFormulator";
import { ruleAgent } from "./workflows/ground/judges/ruleAgent";

/*
 * Canon, the tax attorney: no conversational agent and no user data. The
 * MCP server (mcp.ts) is its contract with Cade and the engine builder.
 */

const storage = await createStorage();

const logger = new ConsoleLogger({ name: "canon", level: "info" });

export const mastra = new Mastra({
  agents: { askQueryFormulator, askAnswerer, queryFormulator, assessRiskAgent, ruleAgent },
  workflows: { ask: askWorkflow, ground: groundWorkflow },
  mcpServers: { canon: canonMcp },
  storage,
  logger,
  observability: createObservability(),
  server: {
    port: Number(process.env.CANON_PORT ?? 4112),
    /* Loopback only; MASTRA_HOST opens it wider. */
    host: process.env.MASTRA_HOST ?? "127.0.0.1",
    // Without this hook Mastra returns a generic 500 with no log line.
    onError: (err, c) => {
      logger.error("unhandled handler error", {
        method: c.req.method,
        path: c.req.path,
        err,
      });
      return c.json({ error: "internal server error" }, 500);
    },
    /* No CORS, as Cade: browsers reach Canon only through the web app's proxy. */
    cors: false,
    /*
     * No user auth: the corpus is shared reference material behind the web
     * app's proxy. requestGuard refuses foreign Origin and Host headers;
     * CANON_API_TOKEN gates the port when it is reachable beyond localhost.
     */
    middleware: [requestGuard, tokenGate],
    apiRoutes: [listRefDocsRoute, refDocPdfRoute, refDocHtmlRoute],
  },
});
