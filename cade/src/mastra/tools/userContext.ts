import type { RequestContext } from "@mastra/core/request-context";
import type { Scope } from "../db/appDb";
import { resolveOwnerFilingForYear } from "../db/filings";
import { DEMO_TAX_YEAR } from "../server/demoSession";
import type { CadeRequestContext } from "../server/requestContext";

export interface UserContext {
  userId: string;
  filingId: string;
  taxYear: number;
  scope: Scope;
  authEmail: string | null;
}

/* Throws when a value cannot resolve: a misconfiguration must surface, not hide behind defaults. */
export async function requireUserContext(
  toolContext: { requestContext?: RequestContext<CadeRequestContext> } | undefined,
): Promise<UserContext> {
  const rc = toolContext?.requestContext;
  if (!rc)
    throw new Error("requestContext missing — was this tool called outside an authed request?");
  const userId = rc.get("userId");
  const authEmail = rc.get("userEmail") ?? null;
  if (!userId)
    throw new Error("owner missing — complete first-run setup in the web app before chatting");
  const taxYear = DEMO_TAX_YEAR;
  const filing = await resolveOwnerFilingForYear(userId, taxYear);
  return {
    userId,
    filingId: filing.id,
    taxYear,
    scope: { userId, filingId: filing.id },
    authEmail,
  };
}
