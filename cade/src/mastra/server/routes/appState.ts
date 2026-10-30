import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import { cade } from "../../agents/cade";
import { cadeWorkingMemorySchema, type PlanItem } from "../../agents/cade.workingMemory";
import { resolveOwnerFilingForYear } from "../../db/filings";
import { listDocuments, type UserDocumentRow } from "../../db/userDocuments";
import { buildCaseState } from "../../tools/caseState";
import { DEMO_TAX_YEAR } from "../demoSession";
import { REQUEST_CONTEXT_KEYS } from "../requestContext";

// Must match web/lib/returns.ts:threadIdFor — no shared package yet.
function threadIdFor(userId: string, returnId: string | number): string {
  return `${userId}::${returnId}`;
}

async function readCadePlan(threadId: string): Promise<PlanItem[]> {
  /* A missing or malformed plan must never take down the whole /app/state response. */
  try {
    const memory = await cade.getMemory();
    if (!memory) return [];
    const raw = await memory.getWorkingMemory({ threadId });
    if (!raw) return [];
    const parsed = cadeWorkingMemorySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return [];
    return parsed.data.plan ?? [];
  } catch {
    return [];
  }
}

export const appStateRoute = registerApiRoute("/app/state", {
  method: "GET",
  handler: async (c) => {
    const requestContext = c.get("requestContext");
    const userId = requestContext?.get(MASTRA_RESOURCE_ID_KEY) as string | undefined;
    const authEmail =
      (requestContext?.get(REQUEST_CONTEXT_KEYS.userEmail) as string | undefined) ?? null;
    if (!userId) return c.json({ error: "unauthorized" }, 401);

    const filing = await resolveOwnerFilingForYear(userId, DEMO_TAX_YEAR);
    const scope = { userId, filingId: filing.id };
    const [caseState, plan, drafts] = await Promise.all([
      buildCaseState(userId, DEMO_TAX_YEAR, authEmail),
      readCadePlan(threadIdFor(userId, DEMO_TAX_YEAR)),
      listDocuments(scope, { category: "drafts", taxYear: DEMO_TAX_YEAR }),
    ]);

    /* listDocuments returns newest first, so the first draft seen per formId is the latest. */
    const latestByForm = new Map<string, UserDocumentRow>();
    for (const d of drafts) {
      const formId = (d.metadata as { formId?: string } | null)?.formId;
      if (formId && !latestByForm.has(formId)) latestByForm.set(formId, d);
    }
    const urlFor = (formId: string) => {
      const d = latestByForm.get(formId);
      return d ? `/documents/${d.id}` : null;
    };

    return c.json({
      taxpayerFirstName: caseState.filingInfo.taxpayerFirstName ?? null,
      authEmail: caseState.authEmail,
      plan,
      factCount: caseState.factCount,
      decisionCount: caseState.decisionRows.length,
      pendingDecisions: caseState.pendingDecisions,
      pendingFacts: caseState.pendingFacts,
      forms: caseState.summaries,
      money: caseState.money,
      documents: {
        form1040Url: urlFor("1040"),
        form540Url: urlFor("540"),
        sidecarUrl: urlFor("sidecar"),
      },
    });
  },
});
