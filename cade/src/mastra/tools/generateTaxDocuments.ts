import { createTool } from "@mastra/core/tools";
import {
  FORMS,
  renderForm,
  type AnyFormField,
  type EvaluatedForm,
  type EvaluatedScenario,
} from "@openreturn/engine";
import { z } from "zod";
import { createDocument } from "../db/userDocuments";
import { loadBlankPdf } from "../formAssets";
import { loadAndEvaluateScenario } from "../loadScenario";
import { cadeRequestContextSchema } from "../server/requestContext";
import { buildCaseStateForScenario } from "./caseState";
import { requireUserContext } from "./userContext";

interface RenderTarget {
  userId: string;
  filingId: string;
  year: number;
}

function lineValue(form: EvaluatedForm<AnyFormField>, fieldId: string): number | null {
  const f = form.fields.find((x) => x.fieldId === fieldId);
  if (!f || !f.result.ok) return null;
  const v = f.result.value;
  return typeof v === "number" ? v : null;
}

function serializeForm<F extends AnyFormField>(
  form: EvaluatedForm<F>,
): {
  formId: string;
  jurisdiction: string;
  title: string;
  mustFile: EvaluatedForm<F>["mustFile"];
  mustFileDerivation: EvaluatedForm<F>["mustFileDerivation"];
  fields: Array<{
    fieldId: string;
    label: string;
    category: string;
    valueType: string;
    result: F["result"];
  }>;
} {
  return {
    formId: form.formId,
    jurisdiction: form.jurisdiction,
    title: form.title,
    mustFile: form.mustFile,
    mustFileDerivation: form.mustFileDerivation,
    fields: form.fields.map((f) => ({
      fieldId: f.fieldId,
      label: f.label,
      category: f.category,
      valueType: f.valueType,
      result: f.result,
    })),
  };
}

function refundOrOwed(
  form: EvaluatedForm<AnyFormField>,
  refundFieldId: string,
  owedFieldId: string,
): { kind: "refund" | "owed" | "balanced"; amount: number } {
  const refund = lineValue(form, refundFieldId);
  const owed = lineValue(form, owedFieldId);
  if (refund !== null && refund > 0) return { kind: "refund", amount: refund };
  if (owed !== null && owed > 0) return { kind: "owed", amount: owed };
  return { kind: "balanced", amount: 0 };
}

function countFields(form: EvaluatedForm<AnyFormField>): {
  ok: number;
  blocked: number;
  unsupported: number;
} {
  const ok = form.fields.filter((f) => f.result.ok).length;
  const unsupported = form.fields.filter((f) => !f.result.ok && f.result.unsupported).length;
  return {
    ok,
    blocked: form.fields.length - ok - unsupported,
    unsupported,
  };
}

/* A non-empty warnings list is a soft regression. */
async function renderAndStoreForm(
  scenario: EvaluatedScenario,
  spec: (typeof FORMS)[number],
  target: RenderTarget,
): Promise<{ url: string; filename: string; linesPopulated: number }> {
  const { pdfBytes, rendered, warnings } = await renderForm(scenario, spec.formId, loadBlankPdf);
  for (const w of warnings) {
    console.warn(`[generate-tax-documents][${spec.formId}] ${w}`);
  }
  const filename = `${spec.displayName} — ${target.year}`;
  const doc = await createDocument({
    userId: target.userId,
    filingId: target.filingId,
    category: "drafts",
    filename,
    storageSlug: `${spec.shortId}-${target.year}`,
    extension: "pdf",
    bytes: pdfBytes,
    mimeType: "application/pdf",
    expiresInDays: 30,
    metadata: { formId: spec.shortId, taxYear: target.year },
  });
  return { url: `/documents/${doc.id}`, filename, linesPopulated: rendered.size };
}

async function renderMustFileForms(scenario: EvaluatedScenario, target: RenderTarget) {
  const documents: Array<{ formId: string; url: string; filename: string }> = [];
  const blockers: Array<{ formId: string; reason: string; missingDecisionKey: string | null }> = [];
  const sidecarForms: Record<string, ReturnType<typeof serializeForm>> = {};
  let totalLinesPopulated = 0;
  let totalCounts = { ok: 0, blocked: 0, unsupported: 0 };

  for (const spec of FORMS) {
    const form = scenario.forms.get(spec.formId);
    if (!form) {
      console.warn(`[generate-tax-documents] no evaluation result for ${spec.formId}`);
      continue;
    }
    if (!form.mustFile.ok) {
      /* Surface it: the agent must record the decision, not read "nothing rendered" as done. */
      blockers.push({
        formId: spec.formId,
        reason: form.mustFile.reason,
        missingDecisionKey: form.mustFile.missingDecisionKey ?? null,
      });
      continue;
    }
    if (!form.mustFile.value) continue;

    const { url, filename, linesPopulated } = await renderAndStoreForm(scenario, spec, target);
    documents.push({ formId: spec.formId, url, filename });
    sidecarForms[spec.formId] = serializeForm(form);
    totalLinesPopulated += linesPopulated;
    const counts = countFields(form);
    totalCounts = {
      ok: totalCounts.ok + counts.ok,
      blocked: totalCounts.blocked + counts.blocked,
      unsupported: totalCounts.unsupported + counts.unsupported,
    };
  }

  return { documents, blockers, sidecarForms, totalLinesPopulated, totalCounts };
}

/* Skipped when nothing rendered: an empty sidecar invites links to a useless JSON file. */
async function writeSidecar(opts: {
  userId: string;
  filingId: string;
  year: number;
  sidecarForms: Record<string, ReturnType<typeof serializeForm>>;
}): Promise<string> {
  const sidecar = {
    userId: opts.userId,
    year: opts.year,
    generatedAt: new Date().toISOString(),
    forms: opts.sidecarForms,
  };
  const sidecarDoc = await createDocument({
    userId: opts.userId,
    filingId: opts.filingId,
    category: "drafts",
    filename: `Forms sidecar — ${opts.year}`,
    storageSlug: `forms-${opts.year}`,
    extension: "json",
    bytes: Buffer.from(JSON.stringify(sidecar, null, 2), "utf-8"),
    mimeType: "application/json",
    expiresInDays: 30,
    metadata: { formId: "sidecar", taxYear: opts.year },
  });
  return `/documents/${sidecarDoc.id}`;
}

/*
 * Nothing renders while an input is pending: a missing input can give a wrong but plausible
 * number (no filing status → zero standard deduction and zero tax).
 */
function pendingInputsResult(pendingDecisions: string[], pendingFacts: string[]) {
  return {
    status: "pending_inputs" as const,
    pendingDecisions,
    pendingFacts,
    blockers: [],
    url: "",
    form540Url: null,
    documents: [],
    markdownLinks: "",
    sidecarUrl: null,
    linesPopulated: 0,
    federalRefundOrOwed: null,
    stateRefundOrOwed: null,
    fieldCounts: { ok: 0, blocked: 0, unsupported: 0 },
  };
}

export const generateTaxDocuments = createTool({
  id: "generate-tax-documents",
  requestContextSchema: cadeRequestContextSchema,
  description:
    "Render the taxpayer's filed forms as PDFs using the form engine. Runs the multi-form evaluator against the current facts and decisions, looks up each catalog field's PDF widget, and writes the value. Returns a list of {formId, url} entries for each form whose mustFile predicate evaluates true, plus a JSON sidecar with the evaluated forms. Call at hand-off (no pending decisions, all required facts present). The tool refuses while any input is pending. Marked draft / not-for-filing — a CPA reviews before submission. Produces Form 1040, plus any of: Form 8949 / Schedule D when the taxpayer has reportable capital sales, Schedule CA (540) and Form 540 when the taxpayer is a CA filer. READ THE RESULT CAREFULLY: if status is 'pending_inputs', NO forms were generated — record each key in pendingDecisions (record-ai-decision) and pendingFacts (record-tax-facts, up to 5 per call; ask the user when you do not know the value), then call this tool again. If status is 'no_forms_rendered', NO forms were generated — tell the user that, report the blockers (record any missingDecisionKey listed), and do NOT present any links or dollar amounts. When forms ARE generated, present them by pasting markdownLinks verbatim — never compose or alter document URLs yourself.",
  inputSchema: z.object({
    year: z.number().int(),
  }),
  outputSchema: z.object({
    /** Unless "ok", nothing was generated: present no links and no numbers. */
    status: z.enum(["ok", "pending_inputs", "no_forms_rendered"]),
    pendingDecisions: z.array(z.string()),
    pendingFacts: z.array(z.string()),
    blockers: z.array(
      z.object({
        formId: z.string(),
        reason: z.string(),
        missingDecisionKey: z.string().nullable(),
      }),
    ),
    /** The 1040 URL, "" when it did not render. */
    url: z.string(),
    form540Url: z.string().nullable(),
    documents: z.array(
      z.object({
        formId: z.string(),
        url: z.string(),
        filename: z.string(),
      }),
    ),
    markdownLinks: z.string(),
    sidecarUrl: z.string().nullable(),
    linesPopulated: z.number(),
    federalRefundOrOwed: z
      .object({
        kind: z.enum(["refund", "owed", "balanced"]),
        amount: z.number(),
      })
      .nullable(),
    stateRefundOrOwed: z
      .object({
        kind: z.enum(["refund", "owed", "balanced"]),
        amount: z.number(),
      })
      .nullable(),
    fieldCounts: z.object({
      ok: z.number(),
      blocked: z.number(),
      unsupported: z.number(),
    }),
  }),
  execute: async (input, context) => {
    const { scope, userId, filingId, taxYear, authEmail } = await requireUserContext(context);
    const { year } = input;

    const scenario = await loadAndEvaluateScenario(scope, { id: filingId, taxYear }, authEmail);
    const { forms } = scenario;
    const { pendingDecisions, pendingFacts } = buildCaseStateForScenario(scenario);
    if (pendingDecisions.length > 0 || pendingFacts.length > 0) {
      return pendingInputsResult(pendingDecisions, pendingFacts);
    }

    const { documents, blockers, sidecarForms, totalLinesPopulated, totalCounts } =
      await renderMustFileForms(scenario, { userId, filingId, year });
    const sidecarUrl =
      documents.length > 0 ? await writeSidecar({ userId, filingId, year, sidecarForms }) : null;

    /* Rendered forms only: a blocked 1040 would report a vacuous "balanced $0". */
    const form1040 = forms.get("form-1040");
    const form540 = forms.get("form-540");
    const federalRefundOrOwed =
      form1040 && form1040.mustFile.ok && form1040.mustFile.value
        ? refundOrOwed(form1040, "form-1040.line.34", "form-1040.line.37")
        : null;
    const stateRefundOrOwed =
      form540 && form540.mustFile.ok && form540.mustFile.value
        ? refundOrOwed(
            form540,
            "form-540.line.115_refund_or_no_amount_due",
            "form-540.line.111_amount_you_owe",
          )
        : null;

    const url1040 = documents.find((d) => d.formId === "form-1040")?.url ?? "";
    const url540 = documents.find((d) => d.formId === "form-540")?.url ?? null;

    /* The ONLY link text the agent may paste: hand-composed links came out malformed or made up. */
    const markdownLinks = [
      ...documents.map((d) => `- [${d.filename}](${d.url})`),
      ...(sidecarUrl ? [`- [Forms data (JSON)](${sidecarUrl})`] : []),
    ].join("\n");

    return {
      status: documents.length > 0 ? ("ok" as const) : ("no_forms_rendered" as const),
      pendingDecisions: [],
      pendingFacts: [],
      blockers,
      url: url1040,
      form540Url: url540,
      documents,
      markdownLinks,
      sidecarUrl,
      linesPopulated: totalLinesPopulated,
      federalRefundOrOwed,
      stateRefundOrOwed,
      fieldCounts: totalCounts,
    };
  },
});
