/**
 * Wave 7.2 · Step 4 — Sales return / RMA snapshot builder.
 *
 * Mirrors `supabase/functions/generate-document/index.ts::fetchSalesReturn`
 * so the client-built snapshot and the legacy server-side fetcher agree
 * until the generate-document short-circuit is retired.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SnapshotBlob } from "./index";

export interface SalesReturnItemRow {
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
}

export interface SalesReturnContactRow {
  name: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
}

export interface SalesReturnBusinessRow {
  id: string;
  name: string | null;
  legal_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  logo_url?: string | null;
  currency?: string | null;
}

export interface SalesReturnHeaderRow {
  id: string;
  return_number: string;
  status: string;
  return_date: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  currency: string | null;
  reason: string | null;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  contact: SalesReturnContactRow | null;
  business: SalesReturnBusinessRow | null;
  items: SalesReturnItemRow[] | null;
}

export interface BuildSalesReturnSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: string;
  sourceDocId: string;
}

export function buildSalesReturnSnapshot(
  ret: SalesReturnHeaderRow,
): BuildSalesReturnSnapshotResult {
  if (!ret.id) throw new Error("buildSalesReturnSnapshot: id required");
  if (!ret.return_number) {
    throw new Error("buildSalesReturnSnapshot: return_number required");
  }
  if (!ret.return_date) {
    throw new Error("buildSalesReturnSnapshot: return_date required");
  }

  const items = (ret.items ?? []).map((item) => ({
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
  }));

  const currency = ret.currency || "USD";

  const snapshot: SnapshotBlob = {
    document_type: "sales_return",
    document_type_label: "SALES RETURN",
    document_number: ret.return_number,
    status: ret.status,
    issue_date: ret.return_date,
    subtotal: Number(ret.subtotal ?? 0),
    tax_amount: Number(ret.tax_amount ?? 0),
    discount_amount: 0,
    total: Number(ret.total ?? 0),
    currency,
    notes: ret.reason ?? null,
    terms: null,
    contact: ret.contact,
    business_id: ret.business_id,
    organization_id: ret.organization_id,
    branch_id: ret.branch_id,
    items,
  };

  return {
    snapshot,
    documentNumber: ret.return_number,
    documentDate: ret.return_date.slice(0, 10),
    organizationId: ret.organization_id,
    businessId: ret.business_id,
    branchId: ret.branch_id,
    currency,
    sourceDocId: ret.id,
  };
}

export async function fetchAndBuildSalesReturnSnapshot(
  supabase: SupabaseClient,
  salesReturnId: string,
): Promise<BuildSalesReturnSnapshotResult> {
  const { data, error } = await supabase
    .from("sales_returns")
    .select(
      `
      id, return_number, status, return_date,
      subtotal, tax_amount, total, currency, reason,
      organization_id, business_id, branch_id,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code),
      business:businesses(id, name, legal_name, email, phone, address, logo_url, currency),
      items:sales_return_items(
        description, quantity, unit_price, tax_rate, tax_amount, line_total,
        packaging:product_packaging(name, qty_in_base_uom),
        product:products(base_uom:units_of_measure!base_uom_id(code, name))
      )
      `,
    )
    .eq("id", salesReturnId)
    .single();

  if (error || !data) {
    throw new Error(
      `fetchAndBuildSalesReturnSnapshot: sales return ${salesReturnId} not found: ${
        error?.message ?? "no row"
      }`,
    );
  }
  return buildSalesReturnSnapshot(data as unknown as SalesReturnHeaderRow);
}