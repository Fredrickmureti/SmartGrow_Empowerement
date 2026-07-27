/**
 * Wave 7.2 — Purchase (vendor) return snapshot builder.
 * Mirrors `supabase/functions/generate-document/index.ts::fetchPurchaseReturn`
 * for `document_kinds.code = 'purchases.return'`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SnapshotBlob } from "./index";

export interface PurchasesReturnItemRow {
  description: string | null;
  quantity: number;
  unit_price: number;
  tax_rate: number | null;
  tax_amount: number | null;
  line_total: number;
  return_reason?: string | null;
  condition?: string | null;
  sku?: string | null;
  packaging?: { name: string | null; qty_in_base_uom: number | null } | null;
  product?: { name?: string | null; sku?: string | null; base_uom?: { code: string | null; name: string | null } | null } | null;
  pack_quantity?: number | null;
  pack_size?: number | null;
  unit_of_measure?: string | null;
}

export interface PurchasesReturnVendorRow {
  name: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  tax_id?: string | null;
}

export interface PurchasesReturnBusinessRow {
  id: string;
  name: string | null;
  base_currency?: string | null;
}

export interface PurchasesReturnHeaderRow {
  id: string;
  return_number: string;
  status: string;
  return_date: string;
  subtotal: number | null;
  tax_amount: number | null;
  total: number;
  currency: string | null;
  notes: string | null;
  reason: string | null;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  vendor_id: string | null;
  contact: PurchasesReturnVendorRow | null;
  business: PurchasesReturnBusinessRow | null;
  items: PurchasesReturnItemRow[] | null;
}

export interface BuildPurchasesReturnSnapshotResult {
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

export function buildPurchasesReturnSnapshot(
  pr: PurchasesReturnHeaderRow,
): BuildPurchasesReturnSnapshotResult {
  if (!pr.id) throw new Error("buildPurchasesReturnSnapshot: pr.id required");
  if (!pr.return_number) throw new Error("buildPurchasesReturnSnapshot: return_number required");
  if (!pr.return_date) throw new Error("buildPurchasesReturnSnapshot: return_date required");

  const items = (pr.items ?? []).map((item) => ({
    description:
      item.description ??
      item.product?.name ??
      null,
    quantity: Number(item.quantity ?? 0),
    unit_price: Number(item.unit_price ?? 0),
    tax_rate: item.tax_rate == null ? 0 : Number(item.tax_rate),
    tax_amount: item.tax_amount == null ? 0 : Number(item.tax_amount),
    line_total: Number(item.line_total ?? 0),
    return_reason: item.return_reason ?? null,
    condition: item.condition ?? null,
    sku: item.sku ?? item.product?.sku ?? null,
    pack_quantity: item.pack_quantity ?? null,
    pack_size: item.pack_size ?? null,
    unit_of_measure:
      item.unit_of_measure ??
      item.packaging?.name ??
      item.product?.base_uom?.code ??
      null,
  }));

  const currency = pr.currency || pr.business?.base_currency || "USD";

  const snapshot: SnapshotBlob = {
    document_type: "vendor_return",
    document_type_label: "VENDOR RETURN",
    document_number: pr.return_number,
    status: pr.status,
    issue_date: pr.return_date,
    subtotal: Number(pr.subtotal ?? 0),
    tax_amount: Number(pr.tax_amount ?? 0),
    discount_amount: 0,
    total: Number(pr.total ?? 0),
    currency,
    notes: pr.notes ?? pr.reason ?? null,
    terms: null,
    contact: pr.contact,
    business_id: pr.business_id,
    organization_id: pr.organization_id,
    branch_id: pr.branch_id,
    items,
  };

  return {
    snapshot,
    documentNumber: pr.return_number,
    documentDate: pr.return_date.slice(0, 10),
    organizationId: pr.organization_id,
    businessId: pr.business_id,
    branchId: pr.branch_id,
    currency,
    sourceDocId: pr.id,
    vendorId: pr.vendor_id,
  };
}

export async function fetchAndBuildPurchasesReturnSnapshot(
  supabase: SupabaseClient,
  prId: string,
): Promise<BuildPurchasesReturnSnapshotResult> {
  const { data, error } = await supabase
    .from("purchase_returns")
    .select(
      `
      id, return_number, status, return_date,
      subtotal, tax_amount, total, currency, notes, reason,
      organization_id, business_id, branch_id, vendor_id,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code, tax_id),
      business:businesses(id, name, base_currency),
      items:purchase_return_items(
        description, quantity, unit_price, tax_rate, tax_amount, line_total,
        return_reason, condition, sku, pack_quantity, pack_size, unit_of_measure,
        packaging:product_packaging(name, qty_in_base_uom),
        product:products(name, sku, base_uom:units_of_measure!base_uom_id(code, name))
      )
      `,
    )
    .eq("id", prId)
    .single();

  if (error || !data) {
    throw new Error(
      `fetchAndBuildPurchasesReturnSnapshot: purchase return ${prId} not found: ${error?.message ?? "no row"}`,
    );
  }
  return buildPurchasesReturnSnapshot(data as unknown as PurchasesReturnHeaderRow);
}
