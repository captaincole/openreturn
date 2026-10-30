import { Mastra } from "@mastra/core";
import "dotenv/config";
import { cade } from "./agents/cade";
import { ConsoleLogger } from "./server/consoleLogger";
import { createObservability } from "./server/observability";
import { ownerMiddleware } from "./server/ownerMiddleware";
import { requestGuard } from "./server/requestGuard";
import { appStateRoute } from "./server/routes/appState";
import { addAskTurnRoute, createAskRoute, getAskThreadRoute } from "./server/routes/ask";
import { createFilingRoute } from "./server/routes/createFiling";
import { deleteFilingRoute } from "./server/routes/deleteFiling";
import { retryReviewsRoute } from "./server/routes/retryReviews";
import { sessionResetRoute } from "./server/routes/sessionReset";
import { createStorage } from "./server/storage";
import { askTurnWorkflow } from "./workflows/askTurn";
import { reviewDecisionWorkflow } from "./workflows/reviewDecision";

const storage = await createStorage();

/* Hoisted for onError: Mastra does not log unhandled handler exceptions before its 500. */
const logger = new ConsoleLogger({ name: "openreturn", level: "info" });

export const mastra = new Mastra({
  /* The one agent. Grounding and tax-code answers come from Canon over MCP (canon/client.ts). */
  agents: { cade },
  workflows: { reviewDecision: reviewDecisionWorkflow, askTurn: askTurnWorkflow },
  storage,
  logger,
  observability: createObservability(),
  server: {
    /* Without a host, Node listens on every interface. MASTRA_HOST opens it wider. */
    host: process.env.MASTRA_HOST ?? "127.0.0.1",
    /*
     * Mastra catches handler throws before any middleware sees them; without this hook
     * they become a generic 500 with no log.
     */
    onError: (err, c) => {
      logger.error("unhandled handler error", {
        method: c.req.method,
        path: c.req.path,
        err,
      });
      return c.json({ error: "internal server error" }, 500);
    },
    /* The browser never calls the agent. Else Mastra sends Access-Control-Allow-Origin: *. */
    cors: false,
    middleware: [
      /* First: refuse foreign Origin and Host headers before anything reads the owner. */
      requestGuard,
      ownerMiddleware,
    ],
    apiRoutes: [
      appStateRoute,
      createFilingRoute,
      deleteFilingRoute,
      retryReviewsRoute,
      sessionResetRoute,
      createAskRoute,
      addAskTurnRoute,
      getAskThreadRoute,
    ],
  },
});
