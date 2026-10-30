import { createStep } from "@mastra/core/workflows";
import { CanonToolError, groundCanon } from "../../canon/client";
import { getDecisionById, setDecisionVerdict } from "../../db/aiDecisions";
import {
  completeReviewRun,
  insertReviewRun,
  recordReviewStep,
  setDecisionLatestRunId,
} from "../../db/reviewRuns";
import { listFactsByKeys, noteQuestion } from "../../db/taxFacts";
import {
  reviewCarrierSchema,
  reviewDecisionOutputSchema,
  reviewInputSchema,
  type ReviewCarrier,
  type ReviewVerdict,
} from "./schemas";

type Scope = { userId: string; filingId: string };

export const initStep = createStep({
  id: "init",
  inputSchema: reviewInputSchema,
  outputSchema: reviewCarrierSchema,
  execute: async ({ inputData }) => {
    const t0 = Date.now();
    const { userId, filingId } = inputData;
    const scope = { userId, filingId };

    const decision = await getDecisionById(scope, inputData.decisionId);
    if (!decision) {
      throw new Error(`init: no ai_decision with id ${inputData.decisionId}`);
    }

    const reviewRunId = crypto.randomUUID();
    await insertReviewRun(scope, { id: reviewRunId, decisionId: decision.id, userId, filingId });
    await setDecisionLatestRunId(scope, decision.id, reviewRunId);

    const facts = await listFactsByKeys(scope, decision.taxYear, decision.supportingFactKeys);

    const carrier: ReviewCarrier = {
      ...inputData,
      reviewRunId,
      decisionKey: decision.decisionKey,
      decision: {
        taxYear: decision.taxYear,
        decisionKey: decision.decisionKey,
        decision: decision.decision,
        rationale: decision.rationale,
        confidence: decision.confidence,
        dissentingConsiderations: decision.dissentingConsiderations,
        supportingFactKeys: decision.supportingFactKeys,
      },
      facts: facts.map((f) => ({
        key: f.key,
        category: f.category,
        value: f.value,
        sourceNote: f.sourceNote,
      })),
    };

    await recordReviewStep(scope, {
      id: crypto.randomUUID(),
      runId: reviewRunId,
      userId,
      filingId,
      iteration: 0, // init runs before the first iteration
      stepKind: "init",
      input: inputData,
      output: { decision: carrier.decision, facts: carrier.facts },
      durationMs: Date.now() - t0,
    });

    return carrier;
  },
});

/* Unset leaves Canon's default (3). The e2e pins 1: it tests the round trip, not the verdict. */
function groundMaxIterations(): number | undefined {
  const raw = process.env.CANON_GROUND_MAX_ITERATIONS;
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`CANON_GROUND_MAX_ITERATIONS: not a count: ${raw}`);
  return n;
}

export const groundStep = createStep({
  id: "ground",
  inputSchema: reviewCarrierSchema,
  outputSchema: reviewCarrierSchema,
  execute: async ({ inputData: carrier }) => {
    const scope = { userId: carrier.userId, filingId: carrier.filingId };
    const run = await groundCanon({
      decision: carrier.decision,
      facts: carrier.facts,
      maxIterations: groundMaxIterations(),
    });
    for (const step of run.log.steps) {
      await recordReviewStep(scope, {
        id: crypto.randomUUID(),
        runId: carrier.reviewRunId,
        userId: carrier.userId,
        filingId: carrier.filingId,
        iteration: step.iteration,
        stepKind: step.kind,
        input: step.input,
        output: step.output,
        durationMs: step.durationMs,
      });
    }
    if (run.status === "failed") throw new CanonToolError(`Canon ground: ${run.error}`);
    const { status: _status, ...ground } = run;
    return { ...carrier, ground };
  },
});

/* Without an open question, a non-accurate verdict sits unread and Cade never circles back. */
async function noteFollowUpQuestion(
  scope: Scope,
  carrier: ReviewCarrier,
  ground: NonNullable<ReviewCarrier["ground"]>,
): Promise<string | undefined> {
  const prompts: Partial<Record<ReviewVerdict, { question: string; context: string | undefined }>> =
    {
      needs_more_facts: {
        question: `Confirm the basis for decision \`${carrier.decisionKey}\` — review couldn't ground it.`,
        context: ground.whatsMissing,
      },
      inaccurate: {
        question: `Revisit decision \`${carrier.decisionKey}\` with the user — review found it conflicts with the evidence.`,
        context: ground.reason,
      },
    };
  const followUp = prompts[ground.verdict];
  if (!followUp) return undefined;

  const openQuestionId = crypto.randomUUID();
  await noteQuestion(scope, {
    id: openQuestionId,
    userId: carrier.userId,
    filingId: carrier.filingId,
    question: followUp.question,
    context: followUp.context,
    decisionId: carrier.decisionId,
  });
  return openQuestionId;
}

export const finalizeStep = createStep({
  id: "finalize",
  inputSchema: reviewCarrierSchema,
  outputSchema: reviewDecisionOutputSchema,
  execute: async ({ inputData: carrier }) => {
    const t0 = Date.now();
    const scope = { userId: carrier.userId, filingId: carrier.filingId };
    const ground = carrier.ground;
    if (!ground) throw new Error("finalize: no ground result — the ground step did not run");

    await setDecisionVerdict(
      scope,
      carrier.decisionId,
      ground.verdict,
      ground.reason,
      ground.citations.length > 0 ? ground.citations : null,
    );

    const openQuestionId = await noteFollowUpQuestion(scope, carrier, ground);

    await completeReviewRun(scope, {
      id: carrier.reviewRunId,
      status: "completed",
      finalVerdict: ground.verdict,
      iterationCount: ground.iterationCount,
      durationMs: Date.now() - t0, // finalize-step time only; per-step durations are in review_run_steps
    });

    const output = {
      decisionId: carrier.decisionId,
      reviewRunId: carrier.reviewRunId,
      iterationCount: ground.iterationCount,
      riskTier: ground.riskTier,
      finalVerdict: ground.verdict,
      reason: ground.reason,
      citations: ground.citations,
      ...(openQuestionId ? { openQuestionId } : {}),
      ...(ground.whatsMissing ? { whatsMissing: ground.whatsMissing } : {}),
    };

    await recordReviewStep(scope, {
      id: crypto.randomUUID(),
      runId: carrier.reviewRunId,
      userId: carrier.userId,
      filingId: carrier.filingId,
      iteration: ground.iterationCount,
      stepKind: "finalize",
      input: { decisionId: carrier.decisionId, decisionKey: carrier.decisionKey },
      output,
      durationMs: Date.now() - t0,
    });

    return output;
  },
});
