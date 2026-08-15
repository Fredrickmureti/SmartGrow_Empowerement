/**
 * Wave 7.2 — Sales credit-note snapshot builder.
 *
 * Converts a credit-note (header + items + contact + business) into the
 * JSON blob the shared rendering engine expects for
 * `document_kinds.code = 'sales.credit_note'`.
 *
 * The output shape mirrors `DocumentData` (defined in
 * `supabase/functions/_shared/templateRenderer.ts`) so both the PDF
 * (A4 default) and thermal renderers consume the same canonical fields
 * — no per-medium template drift.
 *
 * Follows the salesInvoice.ts reference:
 *  - {@link buildSalesCreditNoteSnapshot} — pure, unit-testable.
 *  - {@link fetchAndBuildSalesCreditNoteSnapshot} — Supabase-driven
 *    helper mirroring `generate-document::fetchCreditNote`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSnapshotItems } from "./lineItemUom";
import type { SnapshotBlob } from "./index";
import { resolveSnapshotAddress } from "./partyAddress";

// ---------- Input shapes (mirror fetchCreditNote's projection) ----------

export interface SalesCreditNoteItemRow {
  description: string | null;
  quantity: number;
  unit_price: number;
  tax_rate: number | null;
  tax_amount: number | null;
  line_total: number;
  sku?: string | null;
  packaging?: { name: string | null; qty_in_base_uom: number | null } | null;
  product?: {
    base_uom?: { code: string | null; name: string | null } | null;
  } | null;
  pack_quantity?: number | null;
  pack_size?: number | null;
  unit_of_measure?: string | null;
  /** Pack provenance forwarded to the renderers (see lineItemUom.ts). */
  display_quantity?: number | null;
  packaging_label?: string | null;
  base_uom_label?: string | null;
  uom_snapshot?: string | null;
}

export interface SalesCreditNoteContactRow {
  name: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
}

export interface SalesCreditNoteBusinessRow {
  id: string;
  name: string | null;
  legal_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  logo_url?: string | null;
  base_currency?: string | null;
}

export interface SalesCreditNoteHeaderRow {
  id: string;
  credit_note_number: string;
  status: string;
  issue_date: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  currency: string | null;
  notes: string | null;
  reason?: string | null;
  organization_id: string;
  business_id: string | null;
  /** Frozen printed address; authoritative over live party data. */
  billing_address?: string | null;
  branch_id: string | null;
  contact_id: string | null;
  contact: SalesCreditNoteContactRow | null;
  business: SalesCreditNoteBusinessRow | null;
  credit_note_items: SalesCreditNoteItemRow[] | null;
}

export interface BuildSalesCreditNoteSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: string;
  sourceDocId: string;
  contactId: string | null;
}

/**
 * Deterministic: items are emitted in source order and no wall-clock
 * timestamps are introduced, so repeat calls produce byte-identical
 * output. That's what keeps `ensure_document_record`'s upsert idempotent
 * on retry / reprint.
 */
export function buildSalesCreditNoteSnapshot(
  cn: SalesCreditNoteHeaderRow,
): BuildSalesCreditNoteSnapshotResult {
  if (!cn.id) throw new Error("buildSalesCreditNoteSnapshot: cn.id required");
  if (!cn.credit_note_number) {
    throw new Error("buildSalesCreditNoteSnapshot: credit_note_number required");
  }
  if (!cn.issue_date) {
    throw new Error("buildSalesCreditNoteSnapshot: issue_date required");
  }

  const items = (cn.credit_note_items ?? []).map((item) => ({
    description: item.description,
    quantity: Number(item.quantity ?? 0),
    unit_price: Number(item.unit_price ?? 0),
    tax_rate: item.tax_rate == null ? null : Number(item.tax_rate),
    tax_amount: item.tax_amount == null ? null : Number(item.tax_amount),
    line_total: Number(item.line_total ?? 0),
    sku: item.sku ?? null,
    pack_quantity: item.pack_quantity ?? null,
    pack_size: item.pack_size ?? null,
    unit_of_measure:
      item.unit_of_measure ??
      item.packaging?.name ??
      item.product?.base_uom?.code ??
      null,
    // Pack provenance — the renderers (PDF LineItemsTable, receipt)
    // branch on these; omitting them prints base qty with an
    // invented "ea" unit.
    display_quantity: item.display_quantity ?? null,
    packaging_label: item.packaging_label ?? null,
    base_uom_label: item.base_uom_label ?? null,
    uom_snapshot: item.uom_snapshot ?? null,
  }));

  const currency = cn.currency || "USD";

  const snapshot: SnapshotBlob = {
    document_type: "credit_note",
    document_type_label: "CREDIT NOTE",
    document_number: cn.credit_note_number,
    status: cn.status,
    issue_date: cn.issue_date,
    subtotal: Number(cn.subtotal ?? 0),
    tax_amount: Number(cn.tax_amount ?? 0),
    discount_amount: 0,
    total: Number(cn.total ?? 0),
    currency,
    notes: cn.notes ?? null,
    reason: cn.reason ?? null,
    terms: null,
    contact: cn.contact,
    billing_address: resolveSnapshotAddress(cn.billing_address, cn.contact),
    business_id: cn.business_id,
    organization_id: cn.organization_id,
    branch_id: cn.branch_id,
    items,
  };

  return {
    snapshot,
    documentNumber: cn.credit_note_number,
    documentDate: cn.issue_date.slice(0, 10),
    organizationId: cn.organization_id,
    businessId: cn.business_id,
    branchId: cn.branch_id,
    currency,
    sourceDocId: cn.id,
    contactId: cn.contact_id,
  };
}

/**
 * Loads the exact columns the pure builder needs and returns its
 * result. Mirrors the projection in
 * `supabase/functions/generate-document/index.ts::fetchCreditNote` so
 * client-side snapshots line up with the server-side historical fetcher
 * (until the generate-document short-circuit is retired in Wave 9).
 */
export async function fetchAndBuildSalesCreditNoteSnapshot(
  supabase: SupabaseClient,
  creditNoteId: string,
): Promise<BuildSalesCreditNoteSnapshotResult> {
  const { data, error } = await supabase
    .from("credit_notes")
    .select(
      `
      id, credit_note_number, status, issue_date,
      subtotal, tax_amount, total, currency, notes, reason, billing_address,
      organization_id, business_id, branch_id, contact_id,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code),
      business:businesses(id, name, legal_name, email, phone, address, logo_url, base_currency),
      credit_note_items(
        description, quantity, unit_price, tax_rate, tax_amount, line_total,
        display_quantity, uom_snapshot,
        packaging:product_packaging!packaging_id(name, qty_in_base_uom),
        display_uom:units_of_measure!display_uom_id(code, name),
        product:products(sku, base_uom:units_of_measure!base_uom_id(code, name))
      )
      `,
    )
    .eq("id", creditNoteId)
    .single();

  if (error || !data) {
    throw new Error(
      `fetchAndBuildSalesCreditNoteSnapshot: credit note ${creditNoteId} not found: ${
        error?.message ?? "no row"
      }`,
    );
  }
  return buildSalesCreditNoteSnapshot(
    normalizeSnapshotItems(data as Record<string, unknown>, "credit_note_items") as unknown as SalesCreditNoteHeaderRow,
  );
}
