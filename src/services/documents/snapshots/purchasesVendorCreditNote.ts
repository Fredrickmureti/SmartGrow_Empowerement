/**
 * ADR 0132 Phase 5 — Vendor credit note snapshot builder.
 *
 * A vendor credit note is a document in its own right (`document_kinds.code
 * = 'purchases.credit_note'`), not a variant of the purchase return that may
 * have caused it. It is the supplier-facing statement of what we are
 * claiming back and why, so the snapshot carries the provenance the claim
 * rests on: the supplier's own document number, the origin/reason vocabulary,
 * and the bill / GRN / PO / return it descends from.
 *
 * Snapshots are frozen at print time and replayed byte-for-byte on reprint —
 * never mutate one after it lands in `document_records`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSnapshotItems } from "./lineItemUom";
import type { SnapshotBlob } from "./index";

export interface VendorCreditNoteItemRow {
  description: string | null;
  quantity: number;
  unit_price: number;
  tax_rate: number | null;
  tax_amount: number | null;
  line_total: number;
  sku?: string | null;
  packaging?: { name: string | null; qty_in_base_uom: number | null } | null;
  product?: {
    name?: string | null;
    sku?: string | null;
    base_uom?: { code: string | null; name: string | null } | null;
  } | null;
  pack_quantity?: number | null;
  pack_size?: number | null;
  unit_of_measure?: string | null;
}

export interface VendorCreditNoteHeaderRow {
  id: string;
  credit_note_number: string;
  status: string;
  commercial_status?: string | null;
  accounting_status?: string | null;
  settlement_status?: string | null;
  credit_date: string;
  subtotal: number | null;
  tax_amount: number | null;
  total: number;
  currency: string | null;
  notes: string | null;
  origin?: string | null;
  reason_code?: string | null;
  vendor_document_number?: string | null;
  vendor_document_date?: string | null;
  exchange_rate?: number | null;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  vendor_id: string | null;
  bill?: { bill_number: string | null } | null;
  source_return?: { return_number: string | null } | null;
  contact: Record<string, unknown> | null;
  business: { id: string; name: string | null; base_currency?: string | null } | null;
  items: VendorCreditNoteItemRow[] | null;
}

/** Mirrors `vendor_credit_notes_origin_chk`. */
const ORIGIN_LABELS: Record<string, string> = {
  purchase_return: "Purchase return",
  overbilling: "Overbilling",
  price_correction: "Price correction",
  quantity_discrepancy: "Quantity discrepancy",
  damaged_goods: "Damaged goods",
  rejected_goods: "Rejected goods",
  tax_correction: "Tax correction",
  rebate: "Rebate",
  supplier_credit: "Supplier credit",
  adjustment: "Adjustment",
};

const humanize = (value: string | null | undefined): string | null =>
  value ? (ORIGIN_LABELS[value] ?? value.replace(/_/g, " ")) : null;

/**
 * Provenance block. Empty entries are dropped so a pure financial credit
 * does not print blank logistics rows.
 */
function buildHeaderFields(cn: VendorCreditNoteHeaderRow) {
  const rows: Array<[string, string | null]> = [
    ["Supplier Document", cn.vendor_document_number ?? null],
    [
      "Supplier Document Date",
      cn.vendor_document_date ? cn.vendor_document_date.slice(0, 10) : null,
    ],
    ["Origin", humanize(cn.origin)],
    ["Reason", humanize(cn.reason_code)],
    ["Bill", cn.bill?.bill_number ?? null],
    ["Purchase Return", cn.source_return?.return_number ?? null],
  ];
  return rows
    .filter(([, value]) => value != null && value !== "")
    .map(([field_label, field_value]) => ({
      field_label,
      field_value: field_value as string,
      field_type: "text",
      document_section: "header",
    }));
}

export interface BuildVendorCreditNoteSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: string;
  sourceDocId: string;
  vendorId: string | null;
}

export function buildVendorCreditNoteSnapshot(
  cn: VendorCreditNoteHeaderRow,
): BuildVendorCreditNoteSnapshotResult {
  if (!cn.id) throw new Error("buildVendorCreditNoteSnapshot: cn.id required");
  if (!cn.credit_note_number)
    throw new Error("buildVendorCreditNoteSnapshot: credit_note_number required");
  if (!cn.credit_date) throw new Error("buildVendorCreditNoteSnapshot: credit_date required");

  const items = (cn.items ?? []).map((item) => ({
    description: item.description ?? item.product?.name ?? null,
    quantity: Number(item.quantity ?? 0),
    unit_price: Number(item.unit_price ?? 0),
    tax_rate: item.tax_rate == null ? 0 : Number(item.tax_rate),
    tax_amount: item.tax_amount == null ? 0 : Number(item.tax_amount),
    line_total: Number(item.line_total ?? 0),
    sku: item.sku ?? item.product?.sku ?? null,
    pack_quantity: item.pack_quantity ?? null,
    pack_size: item.pack_size ?? null,
    unit_of_measure:
      item.unit_of_measure ?? item.packaging?.name ?? item.product?.base_uom?.code ?? null,
    // Pack provenance — the renderers branch on these; omitting them prints
    // the base quantity with an invented "ea" unit.
    display_quantity: item.display_quantity ?? null,
    packaging_label: item.packaging_label ?? null,
    base_uom_label: item.base_uom_label ?? null,
    uom_snapshot: item.uom_snapshot ?? null,

  }));

  const currency = cn.currency || cn.business?.base_currency || "USD";

  const snapshot: SnapshotBlob = {
    document_type: "vendor_credit_note",
    document_type_label: "VENDOR CREDIT NOTE",
    document_number: cn.credit_note_number,
    status: cn.commercial_status ?? cn.status,
    issue_date: cn.credit_date,
    subtotal: Number(cn.subtotal ?? 0),
    tax_amount: Number(cn.tax_amount ?? 0),
    discount_amount: 0,
    total: Number(cn.total ?? 0),
    currency,
    exchange_rate: cn.exchange_rate == null ? null : Number(cn.exchange_rate),
    notes: cn.notes ?? null,
    terms: null,
    custom_fields: buildHeaderFields(cn),
    contact: cn.contact,
    business_id: cn.business_id,
    organization_id: cn.organization_id,
    branch_id: cn.branch_id,
    items,
  };

  return {
    snapshot,
    documentNumber: cn.credit_note_number,
    documentDate: cn.credit_date.slice(0, 10),
    organizationId: cn.organization_id,
    businessId: cn.business_id,
    branchId: cn.branch_id,
    currency,
    sourceDocId: cn.id,
    vendorId: cn.vendor_id,
  };
}

export async function fetchAndBuildVendorCreditNoteSnapshot(
  supabase: SupabaseClient,
  creditNoteId: string,
): Promise<BuildVendorCreditNoteSnapshotResult> {
  const { data, error } = await supabase
    .from("vendor_credit_notes")
    .select(
      `
      id, credit_note_number, status, commercial_status, accounting_status, settlement_status,
      credit_date, subtotal, tax_amount, total, currency, notes,
      origin, reason_code, vendor_document_number, vendor_document_date, exchange_rate,
      organization_id, business_id, branch_id, vendor_id,
      bill:bills(bill_number),
      source_return:purchase_returns!vendor_credit_notes_source_return_id_fkey(return_number),
      contact:contacts(name, email, phone, address_line1, city, state, postal_code, tax_id),
      business:businesses(id, name, base_currency),
      items:vendor_credit_note_items(
        description, quantity, unit_price, tax_rate, tax_amount, line_total,
        display_quantity, uom_snapshot,
        packaging:product_packaging!packaging_id(name, qty_in_base_uom),
        display_uom:units_of_measure!display_uom_id(code, name),
        product:products(name, sku, base_uom:units_of_measure!base_uom_id(code, name))
      )
      `,
    )
    .eq("id", creditNoteId)
    .single();

  if (error || !data) {
    throw new Error(
      `fetchAndBuildVendorCreditNoteSnapshot: vendor credit note ${creditNoteId} not found: ${error?.message ?? "no row"}`,
    );
  }
  return buildVendorCreditNoteSnapshot(
    normalizeSnapshotItems(
      data as Record<string, unknown>,
      "items",
    ) as unknown as VendorCreditNoteHeaderRow,
  );
}
