import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getAppDb, nowIso } from "../db/appDb";
import { cadeRequestContextSchema } from "../server/requestContext";
import { requireUserContext } from "./userContext";

export const requestDocumentUpload = createTool({
  id: "request-document-upload",
  requestContextSchema: cadeRequestContextSchema,
  description:
    "Surface a structured document-upload request to the user as a card on their dashboard. Use ONLY when you need a specific tax document (W-2, 1099, K-1, 1098, etc.) and can't proceed without it — never for facts you can ask conversationally. Call once per document needed; don't repeat on subsequent turns. Returns the action id.",
  inputSchema: z.object({
    year: z.number().int().describe("Tax year the document is for (e.g. 2025)."),
    documentType: z
      .string()
      .describe(
        "Short canonical name of the document, e.g. 'W-2', '1099-DIV', '1099-INT', '1099-B', '1099-DA', '1099-MISC', '1099-R', '1099-SA', 'K-1', '1098'. Don't include the year here.",
      ),
    title: z
      .string()
      .describe(
        "User-facing card title in plain English. Be specific — include the issuer if you know it. e.g. 'Upload your 2025 W-2 from Stripe' rather than 'Upload your W-2'.",
      ),
    detail: z
      .string()
      .describe(
        "One short sentence explaining what you need it for. e.g. 'Need Box 1 wages and Box 2 federal withholding to fill 1040 lines 1a and 25a.'",
      ),
  }),
  outputSchema: z.object({
    id: z.string(),
    requested: z.boolean(),
  }),
  execute: async (input, context) => {
    const { userId, filingId } = await requireUserContext(context);
    const db = getAppDb();

    /* One open or processing card per documentType: a repeat call returns the existing card. */
    const existing = await db.execute({
      sql: `SELECT id FROM requested_actions
            WHERE user_id = ? AND tax_year = ?
              AND lower(document_type) = lower(?)
              AND status IN ('open','processing')
            ORDER BY created_at DESC LIMIT 1`,
      args: [userId, input.year, input.documentType],
    });
    if (existing.rows.length > 0) {
      return { id: String(existing.rows[0].id), requested: false };
    }

    const id = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO requested_actions
              (id, user_id, filing_id, tax_year, kind, title, detail,
               document_type, accept_pattern, status, created_at)
            VALUES (?, ?, ?, ?, 'upload', ?, ?, ?, ?, 'open', ?)`,
      args: [
        id,
        userId,
        filingId,
        input.year,
        input.title,
        input.detail,
        input.documentType,
        "application/pdf,image/png,image/jpeg,image/webp",
        nowIso(),
      ],
    });
    return { id, requested: true };
  },
});
