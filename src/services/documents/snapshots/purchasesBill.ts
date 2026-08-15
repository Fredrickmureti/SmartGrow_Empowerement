/**
 * Wave 7.2 — Vendor bill snapshot builder.
 *
 * Converts a vendor bill (header + items + vendor + business) into the
 * JSON blob the shared rendering engine expects for
 * `document_kinds.code = 'purchases.bill'`.
 *
 * Mirrors the projection in
 * `supabase/functions/generate-document/index.ts::fetchBill` so client-
 * side snapshots line up with the server-side historical fetcher (until
 * the generate-document short-circuit is retired in Wave 9).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSnapshotItems } from "./lineItemUom";
import type { SnapshotBlob } from "./index";
import { resolveSnapshotAddress } from "./partyAddress";
import { fetchPaymentTermSnapshot, type SnapshotPaymentTerm } from "./paymentTerm";

// ---------- Input shapes (mirror fetchBill's projection) ----------

export interface PurchasesBillItemRow {
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

export interface PurchasesBillVendorRow {
  name: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
}

export interface PurchasesBillBusinessRow {
  id: string;
  name: string | null;
  legal_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  logo_url?: string | null;
  base_currency?: string | null;
}

export interface PurchasesBillHeaderRow {
  id: string;
  bill_number: string;
  status: string;
  bill_date: string;
  due_date: string | null;
  subtotal: number | null;
  tax_amount: number | null;
  discount_amount: number | null;
  total: number;
  amount_paid: number | null;
  currency: string | null;
  notes: string | null;
  /** Structured supplier term id (drives due_date); NOT T&C prose. */
  payment_term_id?: string | null;
  payment_term?: SnapshotPaymentTerm | null;
  organization_id: string;
  business_id: string | null;
  /** Frozen printed address; authoritative over live party data. */
  remit_to_address?: string | null;
  branch_id: string | null;
  vendor_id: string | null;
  vendor: PurchasesBillVendorRow | null;
  business: PurchasesBillBusinessRow | null;
  items: PurchasesBillItemRow[] | null;
}

export interface BuildPurchasesBillSnapshotResult {
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

/**
 * Deterministic: items are emitted in source order and no wall-clock
 * timestamps are introduced, so repeat calls produce byte-identical
 * output. Keeps `ensure_document_record`'s upsert idempotent on
 * retry / reprint.
 */
export function buildPurchasesBillSnapshot(
  bill: PurchasesBillHeaderRow,
): BuildPurchasesBillSnapshotResult {
  if (!bill.id) throw new Error("buildPurchasesBillSnapshot: bill.id required");
  if (!bill.bill_number) {
    throw new Error("buildPurchasesBillSnapshot: bill_number required");
  }
  if (!bill.bill_date) {
    throw new Error("buildPurchasesBillSnapshot: bill_date required");
  }

  const items = (bill.items ?? []).map((item) => ({
    description: item.description,
    quantity: Number(item.quantity ?? 0),
    unit_price: Number(item.unit_price ?? 0),
    tax_rate: item.tax_rate == null ? 0 : Number(item.tax_rate),
    tax_amount: item.tax_amount == null ? 0 : Number(item.tax_amount),
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

  const currency = bill.currency || "USD";

  const snapshot: SnapshotBlob = {
    document_type: "bill",
    document_type_label: "VENDOR BILL",
    document_number: bill.bill_number,
    status: bill.status,
    issue_date: bill.bill_date,
    due_date: bill.due_date ?? null,
    subtotal: Number(bill.subtotal ?? 0),
    tax_amount: Number(bill.tax_amount ?? 0),
    discount_amount: Number(bill.discount_amount ?? 0),
    total: Number(bill.total ?? 0),
    amount_paid: Number(bill.amount_paid ?? 0),
    currency,
    notes: bill.notes ?? null,
    // `bills` carries no T&C prose column; the structured term travels
    // separately in `payment_term` and must never be stuffed in here.
    terms: null,
    payment_term: bill.payment_term ?? null,
    contact: bill.vendor,
    remit_to_address: resolveSnapshotAddress(bill.remit_to_address, bill.vendor),
    business_id: bill.business_id,
    organization_id: bill.organization_id,
    branch_id: bill.branch_id,
    items,
  };

  return {
    snapshot,
    documentNumber: bill.bill_number,
    documentDate: bill.bill_date.slice(0, 10),
    organizationId: bill.organization_id,
    businessId: bill.business_id,
    branchId: bill.branch_id,
    currency,
    sourceDocId: bill.id,
    vendorId: bill.vendor_id,
  };
}

/**
 * Loads the exact columns the pure builder needs and returns its
 * result. Mirrors the projection in
 * `supabase/functions/generate-document/index.ts::fetchBill`.
 */
export async function fetchAndBuildPurchasesBillSnapshot(
  supabase: SupabaseClient,
  billId: string,
): Promise<BuildPurchasesBillSnapshotResult> {
  const { data, error } = await supabase
    .from("bills")
    .select(
      `
      id, bill_number, status, bill_date, due_date,
      subtotal, tax_amount, discount_amount, total, amount_paid,
      currency, notes, remit_to_address, payment_term_id,
      organization_id, business_id, branch_id, vendor_id,
      vendor:contacts(name, email, phone, address_line1, city, state, postal_code),
      business:businesses(id, name, legal_name, email, phone, address, logo_url, base_currency),
      items:bill_items(
        description, quantity, unit_price, tax_rate, tax_amount, line_total,
        display_quantity, uom_snapshot,
        packaging:product_packaging!packaging_id(name, qty_in_base_uom),
        display_uom:units_of_measure!display_uom_id(code, name),
        product:products(sku, base_uom:units_of_measure!base_uom_id(code, name))
      )
      `,
    )
    .eq("id", billId)
    .single();

  if (error || !data) {
    throw new Error(
      `fetchAndBuildPurchasesBillSnapshot: bill ${billId} not found: ${
        error?.message ?? "no row"
      }`,
    );
  }
  const row = data as Record<string, unknown>;
  const paymentTerm = await fetchPaymentTermSnapshot(
    supabase,
    row.payment_term_id as string | null,
  );
  return buildPurchasesBillSnapshot(
    {
      ...(normalizeSnapshotItems(row, "items") as Record<string, unknown>),
      payment_term: paymentTerm,
    } as unknown as PurchasesBillHeaderRow,
  );
}
