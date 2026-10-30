import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getAppDb, nowIso } from "../db/appDb";
import { cadeRequestContextSchema } from "../server/requestContext";
import { requireUserContext } from "./userContext";

export const dismissRequestedAction = createTool({
  id: "dismiss-requested-action",
  requestContextSchema: cadeRequestContextSchema,
  description:
    "Close a dashboard upload card after you've successfully ingested the document the user uploaded. Pass the same documentType string you used when you called request-document-upload (or the canonical doc name if it was uploaded without a card). Matches the most recent open or processing action with that document type. Safe to call even when no matching card exists.",
  inputSchema: z.object({
    documentType: z
      .string()
      .describe(
        "Canonical document name, e.g. 'W-2', '1099-DIV', '1099-INT', 'K-1'. Match is case-insensitive.",
      ),
  }),
  outputSchema: z.object({
    dismissed: z.boolean(),
    actionId: z.string().nullable(),
  }),
  execute: async (input, context) => {
    const { userId } = await requireUserContext(context);
    const db = getAppDb();

    const found = await db.execute({
      sql: `SELECT id FROM requested_actions
            WHERE user_id = ? AND lower(document_type) = lower(?)
              AND status IN ('open','processing')
            ORDER BY created_at DESC LIMIT 1`,
      args: [userId, input.documentType],
    });
    if (found.rows.length === 0) {
      return { dismissed: false, actionId: null };
    }

    const actionId = String(found.rows[0].id);
    await db.execute({
      sql: `UPDATE requested_actions SET status = 'resolved', resolved_at = ? WHERE id = ?`,
      args: [nowIso(), actionId],
    });
    return { dismissed: true, actionId };
  },
});
