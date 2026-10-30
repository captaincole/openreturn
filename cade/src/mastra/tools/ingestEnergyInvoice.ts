import { createTool } from "@mastra/core/tools";
import {
  ENERGY_ITEM_KINDS,
  makeEnergyInvoiceFactKey,
  type EnergyInvoiceFactValue,
} from "@openreturn/engine/facts";
import { z } from "zod";
import { cadeRequestContextSchema } from "../server/requestContext";
import { recordIngestFact, slugify, type IngestCtx } from "./ingestShared";
import { requireUserContext } from "./userContext";

const ItemSchema = z.object({
  kind: z.enum(ENERGY_ITEM_KINDS).describe("Form 5695 property type"),
  description: z.string().optional().describe("Item as printed on the invoice"),
  qmid: z
    .string()
    .optional()
    .describe("Qualified manufacturer identification number (QMID), 4 characters"),
  cost: z
    .number()
    .describe(
      "Amount paid. Doors, windows, insulation: the product only, no installation labor. Other kinds: include installation labor.",
    ),
});

/* Vendor alone is not unique: a second invoice from one vendor would replace the first. */
export function energyInvoiceSlug(input: {
  vendorName: string;
  invoiceNumber?: string;
  invoiceDate?: string;
}): string {
  const id = input.invoiceNumber ?? input.invoiceDate ?? "";
  return slugify(`${input.vendorName} ${id}`) || "vendor";
}

export const ingestEnergyInvoice = createTool({
  id: "ingest-energy-invoice",
  requestContextSchema: cadeRequestContextSchema,
  description:
    "Ingest one invoice or receipt for home energy improvements (Form 5695 Part II). Call ONCE per invoice, with one item per piece of property. Not for solar panels, batteries, geothermal, or wind (Part I, not supported yet: say so). Writes one fact under category 'home_energy'. Then ask the home questions (main home in the U.S., original user, expected to last 5 years, related to building a new home) if they are not recorded yet.",
  inputSchema: z.object({
    year: z.number().int(),
    vendorName: z.string(),
    invoiceNumber: z.string().optional(),
    invoiceDate: z.string().optional().describe("MM/DD/YYYY"),
    items: z.array(ItemSchema).describe("One entry per qualifying item"),
    sourceNote: z.string().default("Energy improvement invoice ingested via structured payload"),
  }),
  outputSchema: z.object({ factKey: z.string() }),
  execute: async (input, context) => {
    const { scope, userId, filingId } = await requireUserContext(context);
    const ctx: IngestCtx = {
      scope,
      userId,
      filingId,
      year: input.year,
      sourceNote: input.sourceNote,
    };
    const value: EnergyInvoiceFactValue = {
      vendorName: input.vendorName,
      invoiceNumber: input.invoiceNumber,
      invoiceDate: input.invoiceDate,
      items: input.items,
    };
    const factKey = makeEnergyInvoiceFactKey(energyInvoiceSlug(input));
    await recordIngestFact(ctx, "home_energy", factKey, value);
    return { factKey };
  },
});
