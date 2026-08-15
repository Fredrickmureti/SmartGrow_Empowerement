/**
 * Wave 7.2 · Step 3 — Sales order (order acknowledgement) snapshot builder.
 *
 * Converts a sales order (header + items + contact + business) into the
 * JSON blob the shared rendering engine expects for
 * `document_kinds.code = 'sales.order_ack'`.
 *
 * The projection mirrors `supabase/functions/generate-document/index.ts::
 * fetchSalesOrder` field-for-field so the client-built snapshot and the
 * legacy server-side fetcher agree until the generate-document
 * short-circuit is retired in Wave 9.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSnapshotItems } from "./lineItemUom";
import type { SnapshotBlob } from "./index";
import { fetchPaymentTermSnapshot, type SnapshotPaymentTerm } from "./paymentTerm";

// ---------- Input shapes (mirror what fetchSalesOrder selects) ----------

export interface SalesOrderItemRow {
  description: string | null;
  quantity: number;
  unit_price: number;
  tax_rate: number | null;
  tax_amount: number | null;
  discount_percent: number | null;
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

export interface SalesOrderContactRow {
  name: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

export interface SalesOrderBusinessRow {
  id: string;
  name: string | null;
  legal_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  logo_url?: string | null;
  base_currency?: string | null;
}

export interface SalesOrderHeaderRow {
  id: string;
  so_number: string;
  status: string;
  order_date: string;
  expected_date: string | null;
  subtotal: number;
  tax_amount: number;
  discount_amount: number | null;
  shipping_amount: number | null;
  total: number;
  currency: string | null;
  notes: string | null;
  shipping_address: string | null;
  /** Structured customer term id inherited by the spawned invoice. */
  payment_term_id?: string | null;
  payment_term?: SnapshotPaymentTerm | null;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  contact: SalesOrderContactRow | null;
  business: SalesOrderBusinessRow | null;
  items: SalesOrderItemRow[] | null;
}

export interface BuildSalesOrderSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: string;
  sourceDocId: string;
}

/**
 * Deterministic: preserves item order and introduces no wall-clock
 * value, so repeat calls produce byte-identical output. That is what
 * keeps `ensure_document_record`'s upsert idempotent across retry and
 * reprint.
 */
export function buildSalesOrderSnapshot(
  order: SalesOrderHeaderRow,
): BuildSalesOrderSnapshotResult {
  if (!order.id) throw new Error("buildSalesOrderSnapshot: order.id required");
  if (!order.so_number) {
    throw new Error("buildSalesOrderSnapshot: so_number required");
  }
  if (!order.order_date) {
    throw new Error("buildSalesOrderSnapshot: order_date required");
  }

  const items = (order.items ?? []).map((item) => ({
    description: item.description,
    quantity: Number(item.quantity ?? 0),
    unit_price: Number(item.unit_price ?? 0),
    tax_rate: item.tax_rate == null ? null : Number(item.tax_rate),
    tax_amount: item.tax_amount == null ? null : Number(item.tax_amount),
    discount_percent:
      item.discount_percent == null ? null : Number(item.discount_percent),
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

  const currency = order.currency || "USD";

  const snapshot: SnapshotBlob = {
    document_type: "sales_order",
    document_type_label: "SALES ORDER",
    document_number: order.so_number,
    status: order.status,
    issue_date: order.order_date,
    due_date: order.expected_date ?? null,
    subtotal: Number(order.subtotal ?? 0),
    tax_amount: Number(order.tax_amount ?? 0),
    discount_amount: Number(order.discount_amount ?? 0),
    shipping_amount: Number(order.shipping_amount ?? 0),
    total: Number(order.total ?? 0),
    amount_paid: 0,
    currency,
    notes: order.notes ?? null,
    // `sales_orders` carries no T&C prose column; the structured term
    // travels separately in `payment_term`.
    terms: null,
    payment_term: order.payment_term ?? null,
    contact: order.contact,
    shipping_address: order.shipping_address ?? null,
    business_id: order.business_id,
    organization_id: order.organization_id,
    branch_id: order.branch_id,
    items,
  };

  return {
    snapshot,
    documentNumber: order.so_number,
    documentDate: order.order_date.slice(0, 10),
    organizationId: order.organization_id,
    businessId: order.business_id,
    branchId: order.branch_id,
    currency,
    sourceDocId: order.id,
  };
}

/**
 * Loads exactly the columns the pure builder needs and returns its
 * result. Column list mirrors `fetchSalesOrder` in
 * `supabase/functions/generate-document/index.ts`.
 */
export async function fetchAndBuildSalesOrderSnapshot(
  supabase: SupabaseClient,
  salesOrderId: string,
): Promise<BuildSalesOrderSnapshotResult> {
  const { data, error } = await supabase
    .from("sales_orders")
    .select(
      `
      id, so_number, status, order_date, expected_date,
      subtotal, tax_amount, discount_amount, shipping_amount, total,
      currency, notes, shipping_address, payment_term_id,
      organization_id, business_id, branch_id,
      contact:contacts!sales_orders_contact_id_fkey(name, email, phone, address_line1, city, state, postal_code, country),
      business:businesses(id, name, legal_name, email, phone, address, logo_url, base_currency),
      items:sales_order_items(
        description, quantity, unit_price, tax_rate, tax_amount,
        discount_percent, line_total,
        display_quantity, uom_snapshot,
        packaging:product_packaging!packaging_id(name, qty_in_base_uom),
        display_uom:units_of_measure!display_uom_id(code, name),
        product:products(sku, base_uom:units_of_measure!base_uom_id(code, name))
      )
      `,
    )
    .eq("id", salesOrderId)
    .single();

  if (error || !data) {
    throw new Error(
      `fetchAndBuildSalesOrderSnapshot: sales order ${salesOrderId} not found: ${
        error?.message ?? "no row"
      }`,
    );
  }
  const row = data as Record<string, unknown>;
  const paymentTerm = await fetchPaymentTermSnapshot(
    supabase,
    row.payment_term_id as string | null,
  );
  return buildSalesOrderSnapshot({
    ...(normalizeSnapshotItems(row, "items") as Record<string, unknown>),
    payment_term: paymentTerm,
  } as unknown as SalesOrderHeaderRow);
}