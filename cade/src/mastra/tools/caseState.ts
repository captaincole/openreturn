import { createTool } from "@mastra/core/tools";
import type { BaseFormField, EngineDerivation, EvaluatedForm } from "@openreturn/engine";
import {
  getFormSpec,
  pendingInputs,
  type EngineFiling,
  type EvaluatedScenario,
} from "@openreturn/engine";
import { z } from "zod";
import type { Scope } from "../db/appDb";
import { resolveOwnerFilingForYear } from "../db/filings";
import { loadAndEvaluateScenario } from "../loadScenario";
import { cadeRequestContextSchema } from "../server/requestContext";
import { requireUserContext } from "./userContext";

type EvaluatedFormSummary = {
  formId: string;
  jurisdiction: string;
  displayName: string;
  title: string;
  mustFile:
    | { ok: true; value: boolean; rationale: string }
    | { ok: false; reason: string; missingDecisionKey: string | null };
  mustFileDerivation: EngineDerivation | null;
  missingInputs: string[];
  fieldCount: number;
  blockedFieldCount: number;
  unsupportedFieldCount: number;
  blockers: Array<{
    fieldId: string;
    reason: string;
    missingDecisionKey: string | null;
    missingFactKeys: string[] | null;
  }>;
};

export async function buildCaseState(
  userId: string,
  year: number,
  authEmail: string | null = null,
) {
  const filingRow = await resolveOwnerFilingForYear(userId, year);
  const filing: EngineFiling = { id: filingRow.id, taxYear: filingRow.taxYear };
  const scope: Scope = { userId, filingId: filingRow.id };
  return buildCaseStateForScenario(await loadAndEvaluateScenario(scope, filing, authEmail));
}

/* Trusts its inputs: the caller must verify filing_members membership BEFORE it calls this. */
export async function buildCaseStateForFiling(
  scope: Scope,
  taxYear: number,
  authEmail: string | null = null,
) {
  const filing: EngineFiling = { id: scope.filingId, taxYear };
  return buildCaseStateForScenario(await loadAndEvaluateScenario(scope, filing, authEmail));
}

/* Null when the line is blank, never 0: a real $0 must stay distinct from blank. */
function extractMoney(
  form1040: EvaluatedForm<BaseFormField>,
  form540: EvaluatedForm<BaseFormField>,
) {
  return {
    totalWages: numericField(form1040.fields, "form-1040.line.1z"),
    federalAgi: numericField(form1040.fields, "form-1040.line.11a"),
    federalTaxableIncome: numericField(form1040.fields, "form-1040.line.15"),
    federalTax: numericField(form1040.fields, "form-1040.line.24"),
    federalWithholding: numericField(form1040.fields, "form-1040.line.25a"),
    federalRefund: numericField(form1040.fields, "form-1040.line.34"),
    federalOwed: numericField(form1040.fields, "form-1040.line.37"),
    stateTax: numericField(form540.fields, "form-540.line.64_total_tax"),
    stateWithholding: numericField(form540.fields, "form-540.line.71_ca_income_tax_withheld"),
    stateRefund: numericField(form540.fields, "form-540.line.115_refund_or_no_amount_due"),
    stateOwed: numericField(form540.fields, "form-540.line.111_amount_you_owe"),
  };
}

export function buildCaseStateForScenario(scenario: EvaluatedScenario) {
  const { forms, facts, decisions, filingInfo, authEmail } = scenario;
  const form1040 = forms.get("form-1040")!;
  const form540 = forms.get("form-540")!;

  const summaries: EvaluatedFormSummary[] = [summarizeForm(form1040), summarizeForm(form540)];

  const { pendingDecisions, pendingFacts } = pendingInputs(scenario);

  return {
    summaries,
    pendingDecisions,
    pendingFacts,
    /* Null while anything is pending: a missing input gives a wrong but plausible number. */
    money:
      pendingDecisions.length === 0 && pendingFacts.length === 0
        ? extractMoney(form1040, form540)
        : null,
    factCount: facts.length,
    decisionRows: decisions,
    authEmail,
    filingInfo,
    evaluatedForms: [form1040, form540],
  };
}

function summarizeForm(form: EvaluatedForm<BaseFormField>): EvaluatedFormSummary {
  /* Unsupported fields are engine gaps, not user-input gaps: they are not blockers. */
  const blockers = form.fields
    .filter((l) => !l.result.ok && !l.result.unsupported)
    .map((l) => {
      const r = l.result as Extract<typeof l.result, { ok: false }>;
      return {
        fieldId: l.fieldId,
        reason: r.reason,
        missingDecisionKey: r.missingDecisionKey ?? null,
        missingFactKeys: r.missingFactKeys ?? null,
      };
    });
  const unsupportedFieldCount = form.fields.filter(
    (l) => !l.result.ok && l.result.unsupported,
  ).length;
  return {
    formId: form.formId,
    jurisdiction: form.jurisdiction,
    displayName: getFormSpec(form.formId).displayName,
    title: form.title,
    mustFile: form.mustFile.ok
      ? { ok: true, value: form.mustFile.value, rationale: form.mustFile.rationale }
      : {
          ok: false,
          reason: form.mustFile.reason,
          missingDecisionKey: form.mustFile.missingDecisionKey ?? null,
        },
    mustFileDerivation: form.mustFileDerivation ?? null,
    missingInputs: form.missingInputs,
    fieldCount: form.fields.length,
    blockedFieldCount: blockers.length,
    unsupportedFieldCount,
    blockers,
  };
}

function numericField(fields: readonly BaseFormField[], fieldId: string): number | null {
  const field = fields.find((f) => f.fieldId === fieldId);
  if (!field || !field.result.ok) return null;
  const v = field.result.value;
  return typeof v === "number" ? v : null;
}

const moneyLine = z
  .number()
  .nullable()
  .describe("null = blank on the form. Never read null as $0.");

export const getCaseState = createTool({
  id: "get-case-state",
  requestContextSchema: cadeRequestContextSchema,
  description:
    "Returns live case state: per-form summaries (must-file + line count + blockers), aggregated pending decisions and missing facts across all forms, and money convenience fields (wages, AGI, tax, withholding, refund/owed). Call at the start of every turn to know what's required, what's blocked, and what to ask next. The user is identified automatically — pass only the tax year.",
  inputSchema: z.object({
    year: z.number().int().describe("Tax year (e.g. 2025)"),
  }),
  outputSchema: z.object({
    forms: z.array(z.any()),
    pendingDecisions: z.array(z.string()),
    pendingFacts: z.array(z.string()),
    money: z
      .object({
        totalWages: moneyLine,
        federalAgi: moneyLine,
        federalTaxableIncome: moneyLine,
        federalTax: moneyLine,
        federalWithholding: moneyLine,
        federalRefund: moneyLine,
        federalOwed: moneyLine,
        stateTax: moneyLine,
        stateWithholding: moneyLine,
        stateRefund: moneyLine,
        stateOwed: moneyLine,
      })
      .nullable()
      .describe(
        "null while pendingDecisions or pendingFacts has entries: the values are not final.",
      ),
    factCount: z.number(),
    authEmail: z.string().nullable(),
    aiDecisions: z.array(
      z.object({
        id: z.string(),
        decisionKey: z.string(),
        decision: z.any(),
        rationale: z.string(),
        supportingFactKeys: z.array(z.string()),
        confidence: z.string(),
        dissentingConsiderations: z.string().nullable(),
        authorityCitations: z.any().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
  execute: async (_input, context) => {
    const { scope, filingId, taxYear, authEmail: jwtEmail } = await requireUserContext(context);
    const scenario = await loadAndEvaluateScenario(scope, { id: filingId, taxYear }, jwtEmail);
    const { summaries, pendingDecisions, pendingFacts, money, factCount, decisionRows, authEmail } =
      buildCaseStateForScenario(scenario);

    return {
      forms: summaries,
      pendingDecisions,
      pendingFacts,
      money,
      factCount,
      authEmail,
      aiDecisions: decisionRows.map((d) => ({
        id: d.id,
        decisionKey: d.decisionKey,
        decision: d.decision,
        rationale: d.rationale,
        supportingFactKeys: d.supportingFactKeys,
        confidence: d.confidence,
        dissentingConsiderations: d.dissentingConsiderations,
        authorityCitations: d.authorityCitations,
        createdAt: d.createdAt,
      })),
    };
  },
});
