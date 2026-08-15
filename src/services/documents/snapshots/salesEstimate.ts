/**
 * Wave 7.2 — Sales estimate (quotation) snapshot builder.
 *
 * Converts an estimate (header + items + contact + business) into the
 * JSON blob the shared rendering engine expects for
 * `document_kinds.code = 'sales.estimate'`.
 *
 * The projection deliberately mirrors
 * `supabase/functions/generate-document/index.ts::fetchEstimate` so the
 * client-built snapshot and the legacy server-side fetcher agree field
 * for field until the generate-document short-circuit is retired in
 * Wave 9.
 *
 * Two entry points:
 *  - {@link buildSalesEstimateSnapshot} — pure, unit-testable, requires
 *    fully-hydrated input.
 *  - {@link fetchAndBuildSalesEstimateSnapshot} — Supabase-driven helper
 *    so call sites migrate in two lines.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSnapshotItems } from "./lineItemUom";
import type { SnapshotBlob } from "./index";
import { resolveSnapshotAddress } from "./partyAddress";

// ---------- Input shapes (mirror what fetchEstimate selects) ----------

export interface SalesEstimateItemRow {
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

export interface SalesEstimateContactRow {
  name: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

export interface SalesEstimateBusinessRow {
  id: string;
  name: string | null;
  legal_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  logo_url?: string | null;
  base_currency?: string | null;
}

export interface SalesEstimateHeaderRow {
  id: string;
  estimate_number: string;
  status: string;
  issue_date: string;
  expiry_date: string | null;
  subtotal: number;
  tax_amount: number;
  discount_amount: number | null;
  total: number;
  currency: string | null;
  notes: string | null;
  terms: string | null;
  organization_id: string;
  business_id: string | null;
  /** Frozen printed address; authoritative over live party data. */
  billing_address?: string | null;
  branch_id: string | null;
  customer_signature_url?: string | null;
  signed_at?: string | null;
  contact: SalesEstimateContactRow | null;
  business: SalesEstimateBusinessRow | null;
  estimate_items: SalesEstimateItemRow[] | null;
}

export interface BuildSalesEstimateSnapshotResult {
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
 * Deterministic: items keep their supplied order and no wall-clock value
 * is introduced, so repeat calls produce byte-identical output. That is
 * what keeps `ensure_document_record`'s upsert idempotent across retry
 * and reprint.
 */
export function buildSalesEstimateSnapshot(
  estimate: SalesEstimateHeaderRow,
): BuildSalesEstimateSnapshotResult {
  if (!estimate.id) throw new Error("buildSalesEstimateSnapshot: estimate.id required");
  if (!estimate.estimate_number) {
    throw new Error("buildSalesEstimateSnapshot: estimate_number required");
  }
  if (!estimate.issue_date) {
    throw new Error("buildSalesEstimateSnapshot: issue_date required");
  }

  const items = (estimate.estimate_items ?? []).map((item) => ({
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

  const currency = estimate.currency || "USD";

  const snapshot: SnapshotBlob = {
    document_type: "estimate",
    document_type_label: "QUOTATION",
    document_number: estimate.estimate_number,
    status: estimate.status,
    issue_date: estimate.issue_date,
    expiry_date: estimate.expiry_date ?? null,
    subtotal: Number(estimate.subtotal ?? 0),
    tax_amount: Number(estimate.tax_amount ?? 0),
    discount_amount: Number(estimate.discount_amount ?? 0),
    total: Number(estimate.total ?? 0),
    currency,
    notes: estimate.notes ?? null,
    terms: estimate.terms ?? null,
    contact: estimate.contact,
    billing_address: resolveSnapshotAddress(estimate.billing_address, estimate.contact),
    business_id: estimate.business_id,
    organization_id: estimate.organization_id,
    branch_id: estimate.branch_id,
    customer_signature_url: estimate.customer_signature_url ?? null,
    signed_at: estimate.signed_at ?? null,
    items,
  };

  return {
    snapshot,
    documentNumber: estimate.estimate_number,
    documentDate: estimate.issue_date.slice(0, 10),
    organizationId: estimate.organization_id,
    businessId: estimate.business_id,
    branchId: estimate.branch_id,
    currency,
    sourceDocId: estimate.id,
  };
}

/**
 * Loads exactly the columns the pure builder needs and returns its
 * result.
 */
export async function fetchAndBuildSalesEstimateSnapshot(
  supabase: SupabaseClient,
  estimateId: string,
): Promise<BuildSalesEstimateSnapshotResult> {
  const { data, error } = await supabase
    .from("estimates")
    .select(
      `
      id, estimate_number, status, issue_date, expiry_date,
      subtotal, tax_amount, discount_amount, total,
      currency, notes, terms, billing_address,
      organization_id, business_id, branch_id,
      customer_signature_url, signed_at,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code, country),
      business:businesses(id, name, legal_name, email, phone, address, logo_url, base_currency),
      estimate_items(
        description, quantity, unit_price, tax_rate, tax_amount,
        discount_percent, line_total,
        display_quantity, uom_snapshot,
        packaging:product_packaging!packaging_id(name, qty_in_base_uom),
        display_uom:units_of_measure!display_uom_id(code, name),
        product:products(sku, base_uom:units_of_measure!base_uom_id(code, name))
      )
      `,
    )
    .eq("id", estimateId)
    .single();

  if (error || !data) {
    throw new Error(
      `fetchAndBuildSalesEstimateSnapshot: estimate ${estimateId} not found: ${
        error?.message ?? "no row"
      }`,
    );
  }
  return buildSalesEstimateSnapshot(normalizeSnapshotItems(data as Record<string, unknown>, "estimate_items") as unknown as SalesEstimateHeaderRow);
}
