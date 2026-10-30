import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import type { MiddlewareHandler } from "hono";
import { getOwner } from "../db/appDb";
import { REQUEST_CONTEXT_KEYS } from "./requestContext";
import { bearerMatches } from "./requestGuard";

/*
 * Identity = the instance. The agent binds to 127.0.0.1; the web app authenticates the
 * browser and proxies here. AGENT_API_TOKEN, when set, gates /api/* and /app/* for a port
 * reachable beyond localhost. The owner id on MASTRA_RESOURCE_ID_KEY scopes Mastra memory.
 * Before first-run setup there is no owner: requests still flow, and tools throw.
 */

const PROTECTED_PREFIXES = ["/api/", "/app/"];

export const ownerMiddleware: MiddlewareHandler = async (c, next) => {
  const token = process.env.AGENT_API_TOKEN;
  if (token && PROTECTED_PREFIXES.some((p) => c.req.path.startsWith(p))) {
    if (!bearerMatches(c.req.header("Authorization"), token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
  }

  const requestContext = c.get("requestContext");
  if (requestContext && typeof requestContext.set === "function") {
    const owner = await getOwner();
    if (owner) {
      requestContext.set(MASTRA_RESOURCE_ID_KEY, owner.id);
      requestContext.set(REQUEST_CONTEXT_KEYS.userId, owner.id);
      requestContext.set(REQUEST_CONTEXT_KEYS.userEmail, owner.email);
    }
  }
  await next();
};
