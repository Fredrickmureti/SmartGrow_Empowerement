/**
 * Wave 7.2 — Purchase (vendor) return snapshot builder.
 * Mirrors `supabase/functions/generate-document/index.ts::fetchPurchaseReturn`
 * for `document_kinds.code = 'purchases.return'`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSnapshotItems } from "./lineItemUom";
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
  lot_number?: string | null;
  serial_number?: string | null;
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
  reason_code?: string | null;
  return_kind?: string | null;
  rma_reference?: string | null;
  dispatched_at?: string | null;
  purchase_order?: { po_number: string | null } | null;
  goods_receipt?: { receipt_number: string | null } | null;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  vendor_id: string | null;
  contact: PurchasesReturnVendorRow | null;
  business: PurchasesReturnBusinessRow | null;
  items: PurchasesReturnItemRow[] | null;
}

/** Mirrors PURCHASE_RETURN_REASON_CODES and the edge fetcher's copy. */
const REASON_LABELS: Record<string, string> = {
  damaged: "Damaged in transit",
  defective: "Defective / quality reject",
  wrong_item: "Wrong item supplied",
  over_delivery: "Over-delivery",
  expired: "Expired / short shelf life",
  not_ordered: "Not ordered",
  price_dispute: "Price or billing dispute",
  other: "Other",
};

function reasonLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return REASON_LABELS[code] ?? code.replace(/_/g, " ");
}

/**
 * Traceability header for the supplier copy — the RMA the supplier issued and
 * the PO / GRN the goods arrived on. Empty entries are dropped so a financial
 * adjustment does not print blank logistics rows.
 */
function buildHeaderFields(pr: PurchasesReturnHeaderRow) {
  const rows: Array<[string, string | null]> = [
    ["RMA Reference", pr.rma_reference ?? null],
    [
      "Return Type",
      pr.return_kind === "financial" ? "Financial adjustment (no goods)" : "Goods return",
    ],
    ["Reason", reasonLabel(pr.reason_code)],
    ["Purchase Order", pr.purchase_order?.po_number ?? null],
    ["Goods Receipt", pr.goods_receipt?.receipt_number ?? null],
    ["Dispatched", pr.dispatched_at ? pr.dispatched_at.slice(0, 10) : null],
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

function decorateLine(description: string | null, item: PurchasesReturnItemRow): string | null {
  if (!description) return description;
  const parts: string[] = [];
  if (item.lot_number) parts.push(`Lot ${item.lot_number}`);
  if (item.serial_number) parts.push(`S/N ${item.serial_number}`);
  if (item.condition) parts.push(item.condition.replace(/_/g, " "));
  const reason = reasonLabel(item.return_reason);
  if (reason) parts.push(reason);
  return parts.length ? `${description} (${parts.join(" · ")})` : description;
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
    description: decorateLine(item.description ?? item.product?.name ?? null, item),
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
    custom_fields: buildHeaderFields(pr),
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
      reason_code, return_kind, rma_reference, dispatched_at,
      organization_id, business_id, branch_id, vendor_id,
      purchase_order:purchase_orders(po_number),
      goods_receipt:goods_receipts(receipt_number),
      contact:contacts(name, email, phone, address_line1, city, state, postal_code, tax_id),
      business:businesses(id, name, base_currency),
      items:purchase_return_items(
        description, quantity, unit_price, tax_rate, tax_amount, line_total,
        return_reason, condition, lot_number, serial_number,
        display_quantity, uom_snapshot,
        packaging:product_packaging!packaging_id(name, qty_in_base_uom),
        display_uom:units_of_measure!display_uom_id(code, name),
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
  return buildPurchasesReturnSnapshot(normalizeSnapshotItems(data as Record<string, unknown>, "items") as unknown as PurchasesReturnHeaderRow);
}
