/**
 * Wave 7.2 · Step 2 — Sales proforma invoice snapshot builder.
 *
 * Converts a proforma invoice (header + items + contact + business)
 * into the JSON blob the shared rendering engine expects for
 * `document_kinds.code = 'sales.proforma'`.
 *
 * The projection deliberately mirrors
 * `supabase/functions/generate-document/index.ts::fetchProforma` so the
 * client-built snapshot and the legacy server-side fetcher agree field
 * for field until the generate-document short-circuit is retired in
 * Wave 9.
 *
 * Two entry points:
 *  - {@link buildSalesProformaSnapshot} — pure, unit-testable, requires
 *    fully-hydrated input.
 *  - {@link fetchAndBuildSalesProformaSnapshot} — Supabase-driven helper
 *    so call sites migrate in two lines.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSnapshotItems } from "./lineItemUom";
import type { SnapshotBlob } from "./index";
import { resolveSnapshotAddress } from "./partyAddress";

// ---------- Input shapes (mirror what fetchProforma selects) ----------

export interface SalesProformaItemRow {
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

export interface SalesProformaContactRow {
  name: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

export interface SalesProformaBusinessRow {
  id: string;
  name: string | null;
  legal_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  logo_url?: string | null;
  base_currency?: string | null;
}

export interface SalesProformaHeaderRow {
  id: string;
  proforma_number: string;
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
  contact: SalesProformaContactRow | null;
  business: SalesProformaBusinessRow | null;
  proforma_invoice_items: SalesProformaItemRow[] | null;
}

export interface BuildSalesProformaSnapshotResult {
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
export function buildSalesProformaSnapshot(
  proforma: SalesProformaHeaderRow,
): BuildSalesProformaSnapshotResult {
  if (!proforma.id) throw new Error("buildSalesProformaSnapshot: proforma.id required");
  if (!proforma.proforma_number) {
    throw new Error("buildSalesProformaSnapshot: proforma_number required");
  }
  if (!proforma.issue_date) {
    throw new Error("buildSalesProformaSnapshot: issue_date required");
  }

  const items = (proforma.proforma_invoice_items ?? []).map((item) => ({
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

  const currency = proforma.currency || "USD";

  const snapshot: SnapshotBlob = {
    document_type: "proforma",
    document_type_label: "PROFORMA INVOICE",
    document_number: proforma.proforma_number,
    status: proforma.status,
    issue_date: proforma.issue_date,
    expiry_date: proforma.expiry_date ?? null,
    subtotal: Number(proforma.subtotal ?? 0),
    tax_amount: Number(proforma.tax_amount ?? 0),
    discount_amount: Number(proforma.discount_amount ?? 0),
    total: Number(proforma.total ?? 0),
    currency,
    notes: proforma.notes ?? null,
    terms: proforma.terms ?? null,
    contact: proforma.contact,
    billing_address: resolveSnapshotAddress(proforma.billing_address, proforma.contact),
    business_id: proforma.business_id,
    organization_id: proforma.organization_id,
    branch_id: proforma.branch_id,
    items,
  };

  return {
    snapshot,
    documentNumber: proforma.proforma_number,
    documentDate: proforma.issue_date.slice(0, 10),
    organizationId: proforma.organization_id,
    businessId: proforma.business_id,
    branchId: proforma.branch_id,
    currency,
    sourceDocId: proforma.id,
  };
}

/**
 * Loads exactly the columns the pure builder needs and returns its
 * result.
 */
export async function fetchAndBuildSalesProformaSnapshot(
  supabase: SupabaseClient,
  proformaId: string,
): Promise<BuildSalesProformaSnapshotResult> {
  const { data, error } = await supabase
    .from("proforma_invoices")
    .select(
      `
      id, proforma_number, status, issue_date, expiry_date,
      subtotal, tax_amount, discount_amount, total,
      currency, notes, terms, billing_address,
      organization_id, business_id, branch_id,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code, country),
      business:businesses(id, name, legal_name, email, phone, address, logo_url, base_currency),
      proforma_invoice_items(
        description, quantity, unit_price, tax_rate, tax_amount,
        discount_percent, line_total,
        product:products(sku, base_uom:units_of_measure!base_uom_id(code, name))
      )
      `,
    )
    .eq("id", proformaId)
    .single();

  if (error || !data) {
    throw new Error(
      `fetchAndBuildSalesProformaSnapshot: proforma ${proformaId} not found: ${
        error?.message ?? "no row"
      }`,
    );
  }
  return buildSalesProformaSnapshot(normalizeSnapshotItems(data as Record<string, unknown>, "proforma_invoice_items") as unknown as SalesProformaHeaderRow);
}
