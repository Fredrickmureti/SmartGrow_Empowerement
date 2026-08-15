/**
 * Wave 7.2 — Purchase order snapshot builder.
 *
 * Mirrors `supabase/functions/generate-document/index.ts::fetchPurchaseOrder`
 * for `document_kinds.code = 'purchases.po'`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSnapshotItems } from "./lineItemUom";
import type { SnapshotBlob } from "./index";

export interface PurchasesPoItemRow {
  description: string | null;
  quantity: number;
  unit_price: number;
  tax_rate: number | null;
  tax_amount: number | null;
  line_total: number;
  sku?: string | null;
  packaging?: { name: string | null; qty_in_base_uom: number | null } | null;
  product?: { base_uom?: { code: string | null; name: string | null } | null } | null;
  pack_quantity?: number | null;
  pack_size?: number | null;
  unit_of_measure?: string | null;
  /** Pack provenance forwarded to the renderers (see lineItemUom.ts). */
  display_quantity?: number | null;
  packaging_label?: string | null;
  base_uom_label?: string | null;
  uom_snapshot?: string | null;
}

export interface PurchasesPoVendorRow {
  name: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
}

export interface PurchasesPoBusinessRow {
  id: string;
  name: string | null;
  legal_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  logo_url?: string | null;
  base_currency?: string | null;
}

export interface PurchasesPoHeaderRow {
  id: string;
  po_number: string;
  status: string;
  order_date: string;
  expected_date: string | null;
  subtotal: number | null;
  tax_amount: number | null;
  discount_amount: number | null;
  total: number;
  currency: string | null;
  notes: string | null;
  shipping_address: string | null;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  vendor_id: string | null;
  vendor: PurchasesPoVendorRow | null;
  business: PurchasesPoBusinessRow | null;
  items: PurchasesPoItemRow[] | null;
}

export interface BuildPurchasesPoSnapshotResult {
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

export function buildPurchasesPoSnapshot(
  po: PurchasesPoHeaderRow,
): BuildPurchasesPoSnapshotResult {
  if (!po.id) throw new Error("buildPurchasesPoSnapshot: po.id required");
  if (!po.po_number) throw new Error("buildPurchasesPoSnapshot: po_number required");
  if (!po.order_date) throw new Error("buildPurchasesPoSnapshot: order_date required");

  const items = (po.items ?? []).map((item) => ({
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

  const currency = po.currency || "USD";

  const snapshot: SnapshotBlob = {
    document_type: "purchase_order",
    document_type_label: "PURCHASE ORDER",
    document_number: po.po_number,
    status: po.status,
    issue_date: po.order_date,
    due_date: po.expected_date ?? null,
    subtotal: Number(po.subtotal ?? 0),
    tax_amount: Number(po.tax_amount ?? 0),
    discount_amount: Number(po.discount_amount ?? 0),
    total: Number(po.total ?? 0),
    currency,
    notes: po.notes ?? null,
    terms: null,
    contact: po.vendor,
    business_id: po.business_id,
    organization_id: po.organization_id,
    branch_id: po.branch_id,
    shipping_address: po.shipping_address ?? null,
    items,
  };

  return {
    snapshot,
    documentNumber: po.po_number,
    documentDate: po.order_date.slice(0, 10),
    organizationId: po.organization_id,
    businessId: po.business_id,
    branchId: po.branch_id,
    currency,
    sourceDocId: po.id,
    vendorId: po.vendor_id,
  };
}

export async function fetchAndBuildPurchasesPoSnapshot(
  supabase: SupabaseClient,
  poId: string,
): Promise<BuildPurchasesPoSnapshotResult> {
  const { data, error } = await supabase
    .from("purchase_orders")
    .select(
      `
      id, po_number, status, order_date, expected_date,
      subtotal, tax_amount, discount_amount, total, currency, notes,
      shipping_address, organization_id, business_id, branch_id, vendor_id,
      vendor:contacts(name, email, phone, address_line1, city, state, postal_code),
      business:businesses(id, name, legal_name, email, phone, address, logo_url, base_currency),
      items:purchase_order_items(
        description, quantity, unit_price, tax_rate, tax_amount, line_total,
        display_quantity, uom_snapshot,
        packaging:product_packaging!packaging_id(name, qty_in_base_uom),
        display_uom:units_of_measure!display_uom_id(code, name),
        product:products(sku, base_uom:units_of_measure!base_uom_id(code, name))
      )
      `,
    )
    .eq("id", poId)
    .single();

  if (error || !data) {
    throw new Error(
      `fetchAndBuildPurchasesPoSnapshot: po ${poId} not found: ${error?.message ?? "no row"}`,
    );
  }
  return buildPurchasesPoSnapshot(normalizeSnapshotItems(data as Record<string, unknown>, "items") as unknown as PurchasesPoHeaderRow);
}
