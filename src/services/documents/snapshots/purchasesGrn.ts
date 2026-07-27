/**
 * Wave 7.2 — Goods Received Note (GRN) snapshot builder.
 *
 * Mirrors `supabase/functions/generate-document/index.ts::fetchGoodsReceivedNote`
 * for `document_kinds.code = 'purchases.grn'`.
 *
 * A GRN is a QUANTITY-ONLY document: it proves what physically arrived at
 * the dock, not what it costs. Pricing lives on the purchase order and the
 * vendor bill. Every monetary field is therefore emitted as a hard zero
 * rather than copied from the PO — a receiving clerk must never be handed a
 * document that looks like a priced commitment.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SnapshotBlob } from "./index";

export interface PurchasesGrnItemRow {
  description: string | null;
  quantity_received: number | null;
  sku?: string | null;
  pack_quantity?: number | null;
  pack_size?: number | null;
  unit_of_measure?: string | null;
  packaging?: { name: string | null; qty_in_base_uom: number | null } | null;
  product?: { base_uom?: { code: string | null; name: string | null } | null } | null;
}

export interface PurchasesGrnVendorRow {
  name: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
}

export interface PurchasesGrnHeaderRow {
  id: string;
  receipt_number: string;
  status: string;
  receipt_date: string;
  notes: string | null;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  purchase_order_id?: string | null;
  purchase_order?: {
    po_number: string | null;
    currency: string | null;
    vendor_id?: string | null;
    vendor: PurchasesGrnVendorRow | null;
  } | null;
  items: PurchasesGrnItemRow[] | null;
}

export interface BuildPurchasesGrnSnapshotResult {
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

export function buildPurchasesGrnSnapshot(
  grn: PurchasesGrnHeaderRow,
): BuildPurchasesGrnSnapshotResult {
  if (!grn.id) throw new Error("buildPurchasesGrnSnapshot: grn.id required");
  if (!grn.receipt_number)
    throw new Error("buildPurchasesGrnSnapshot: receipt_number required");
  if (!grn.receipt_date)
    throw new Error("buildPurchasesGrnSnapshot: receipt_date required");

  const items = (grn.items ?? []).map((item) => ({
    description: item.description,
    quantity: Number(item.quantity_received ?? 0),
    // Quantity-only document — see file header.
    unit_price: 0,
    tax_rate: 0,
    tax_amount: 0,
    line_total: 0,
    sku: item.sku ?? null,
    pack_quantity: item.pack_quantity ?? null,
    pack_size: item.pack_size ?? null,
    unit_of_measure:
      item.unit_of_measure ??
      item.packaging?.name ??
      item.product?.base_uom?.code ??
      null,
  }));

  // Currency is carried for tenancy/report grouping only; no priced column
  // is rendered on a GRN.
  const currency = grn.purchase_order?.currency || "USD";

  const snapshot: SnapshotBlob = {
    document_type: "goods_received_note",
    document_type_label: "GOODS RECEIVED NOTE",
    document_number: grn.receipt_number,
    status: grn.status,
    issue_date: grn.receipt_date,
    due_date: null,
    subtotal: 0,
    tax_amount: 0,
    discount_amount: 0,
    total: 0,
    currency,
    notes: grn.notes ?? null,
    terms: null,
    contact: grn.purchase_order?.vendor ?? null,
    business_id: grn.business_id,
    organization_id: grn.organization_id,
    branch_id: grn.branch_id,
    shipping_address: null,
    reference: grn.purchase_order?.po_number ?? null,
    items,
  };

  return {
    snapshot,
    documentNumber: grn.receipt_number,
    documentDate: grn.receipt_date.slice(0, 10),
    organizationId: grn.organization_id,
    businessId: grn.business_id,
    branchId: grn.branch_id,
    currency,
    sourceDocId: grn.id,
    vendorId: grn.purchase_order?.vendor_id ?? null,
  };
}

export async function fetchAndBuildPurchasesGrnSnapshot(
  supabase: SupabaseClient,
  grnId: string,
): Promise<BuildPurchasesGrnSnapshotResult> {
  const { data, error } = await supabase
    .from("goods_receipts")
    .select(
      `
      id, receipt_number, status, receipt_date, notes,
      organization_id, business_id, branch_id, purchase_order_id,
      purchase_order:purchase_orders(
        po_number, currency, vendor_id,
        vendor:contacts(name, email, phone, address_line1, city, state, postal_code)
      ),
      items:goods_receipt_items(
        description, quantity_received, sku, pack_quantity, pack_size, unit_of_measure,
        packaging:product_packaging(name, qty_in_base_uom),
        product:products(base_uom:units_of_measure!base_uom_id(code, name))
      )
      `,
    )
    .eq("id", grnId)
    .single();

  if (error || !data) {
    throw new Error(
      `fetchAndBuildPurchasesGrnSnapshot: goods receipt ${grnId} not found: ${error?.message ?? "no row"}`,
    );
  }
  return buildPurchasesGrnSnapshot(data as unknown as PurchasesGrnHeaderRow);
}
