import { MASTRA_RESOURCE_ID_KEY, RequestContext } from "@mastra/core/request-context";
import { createWorkflow } from "@mastra/core/workflows";
import { errorMessage, isCanonUnreachable } from "../../canon/client";
import { listDecisions, setDecisionVerdict } from "../../db/aiDecisions";
import type { Scope } from "../../db/appDb";
import { completeReviewRun } from "../../db/reviewRuns";
import {
  reviewDecisionOutputSchema,
  reviewInputSchema,
  type ReviewDecisionOutput,
} from "./schemas";
import { finalizeStep, groundStep, initStep } from "./steps";

/*
 * init → ground → finalize; the judges run in Canon. A failed run stamps the decision from
 * onError (review_unreached: Canon never got the call; review_failed: the review broke), so
 * every run ends definitively wherever it was started. Mastra awaits onError and logs its throws.
 */
export const reviewDecisionWorkflow = createWorkflow({
  id: "review-decision",
  inputSchema: reviewInputSchema,
  outputSchema: reviewDecisionOutputSchema,
  options: {
    onError: async ({ error, steps, getInitData }) => {
      const input = reviewInputSchema.parse(getInitData());
      const scope = { userId: input.userId, filingId: input.filingId };
      await recordReviewFailure(scope, failureOutput(input.decisionId, error, steps));
    },
  },
})
  .then(initStep)
  .then(groundStep)
  .then(finalizeStep)
  .commit();

export type { ReviewDecisionOutput };

/*
 * Never throws: a failure stamps review_unreached (Canon never got the call; retried later)
 * or review_failed (the review ran and broke; a retry would likely break again).
 */
export async function reviewDecision(
  scope: Scope,
  decisionId: string,
): Promise<ReviewDecisionOutput> {
  const requestContext = new RequestContext();
  requestContext.set(MASTRA_RESOURCE_ID_KEY, scope.userId);

  const run = await reviewDecisionWorkflow.createRun({ resourceId: scope.userId });
  const result = await run.start({
    inputData: { decisionId, userId: scope.userId, filingId: scope.filingId },
    requestContext,
  });
  if (result.status === "success") return result.result;
  if (result.status === "failed") return failureOutput(decisionId, result.error, result.steps);
  throw new Error(`review-decision: unexpected workflow status '${result.status}'`);
}

/* One at a time: the judges share one model, so parallel reviews time out together. */

let queue: Promise<unknown> = Promise.resolve();
const queued = new Set<string>();

export function enqueueReview(scope: Scope, decisionId: string): Promise<ReviewDecisionOutput> {
  if (queued.has(decisionId)) {
    return Promise.reject(new Error(`review-decision: ${decisionId} is already queued`));
  }
  queued.add(decisionId);
  const run = queue.then(
    () => reviewDecision(scope, decisionId),
    () => reviewDecision(scope, decisionId),
  );
  queue = run.finally(() => queued.delete(decisionId));
  return run;
}

/*
 * `except` leaves out the review that just ran: a timed-out call may still run in Canon,
 * and a resend would put two grounds on the judges' model at once.
 */
export async function retryUnreachedReviews(
  scope: Scope,
  except?: string,
): Promise<ReviewDecisionOutput[]> {
  const unreached = await listDecisions(scope, { verdict: "review_unreached" });
  const runs = unreached
    .filter((d) => d.id !== except && !queued.has(d.id))
    .map((d) => enqueueReview(scope, d.id));
  return Promise.all(runs);
}

/* An unreached review is no evidence Canon is back, so it starts no sweep. */
export function retryAfter(scope: Scope, out: ReviewDecisionOutput): Promise<unknown> {
  if (out.finalVerdict === "review_unreached") return Promise.resolve();
  return retryUnreachedReviews(scope, out.decisionId);
}

/* init's output carries the run id; when init failed only ai_decisions is stamped. */
function failureOutput(
  decisionId: string,
  err: unknown,
  steps: Record<string, { status: string; output?: unknown }>,
): ReviewDecisionOutput {
  const initOutput = steps.init?.status === "success" ? steps.init.output : undefined;
  const reviewRunId = (initOutput as { reviewRunId?: string } | undefined)?.reviewRunId ?? "";
  return {
    decisionId,
    reviewRunId,
    iterationCount: 0,
    riskTier: null,
    finalVerdict: isCanonUnreachable(err) ? "review_unreached" : "review_failed",
    reason: errorMessage(err),
    citations: [],
  };
}

/*
 * Best-effort failure recording: stamp the decision row and, when init
 * opened one, the review_runs row, so Cade (and the trace log) see why
 * the run failed. Each write is its own try: the original error is what
 * matters.
 */
async function recordReviewFailure(scope: Scope, out: ReviewDecisionOutput): Promise<void> {
  try {
    await setDecisionVerdict(scope, out.decisionId, out.finalVerdict, out.reason, null);
  } catch {
    /* swallow — the original error is what matters */
  }
  if (!out.reviewRunId) return;
  try {
    await completeReviewRun(scope, {
      id: out.reviewRunId,
      status: "failed",
      finalVerdict: out.finalVerdict,
      iterationCount: 0,
      durationMs: 0,
      error: out.reason,
    });
  } catch {
    /* swallow */
  }
}
