/**
 * Wave 7.2 · Step 3 — Sales delivery note snapshot builder.
 *
 * Converts a delivery note (header + lines + logistics + recipient
 * resolution) into the JSON blob the shared rendering engine expects
 * for `document_kinds.code = 'sales.delivery_note'`.
 *
 * The projection deliberately mirrors
 * `supabase/functions/generate-document/index.ts::fetchDeliveryNote`,
 * including its three defensive behaviours, which are business rules,
 * not cosmetics:
 *   1. `hide_amounts` — a delivery note is a goods document; prices must
 *      never render on it even though the lines carry product refs.
 *   2. Recipient chain with UUID guard — contact → proof-of-delivery →
 *      staff profile → legacy free-text, refusing any value that is a
 *      raw UUID so operators never see an id printed as a person.
 *   3. Legacy automation token stripping from notes.
 *
 * Two entry points:
 *  - {@link buildSalesDeliveryNoteSnapshot} — pure, unit-testable,
 *    requires fully-hydrated input (async lookups pre-resolved).
 *  - {@link fetchAndBuildSalesDeliveryNoteSnapshot} — Supabase-driven
 *    helper that performs those lookups and delegates.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSnapshotItems } from "./lineItemUom";
import type { SnapshotBlob } from "./index";

// ---------- Input shapes (mirror what fetchDeliveryNote selects) ----------

export interface SalesDeliveryNoteItemRow {
  description: string | null;
  quantity_ordered: number | null;
  quantity_delivered: number | null;
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

export interface SalesDeliveryNoteContactRow {
  name: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
}

export interface SalesDeliveryNoteHeaderRow {
  id: string;
  delivery_number: string;
  status: string;
  delivery_date: string;
  notes: string | null;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  shipping_address: string | null;
  driver_name: string | null;
  vehicle_number: string | null;
  shipping_method: string | null;
  tracking_number: string | null;
  dispatch_route: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  ready_at: string | null;
  freight_cost: number | null;
  freight_currency: string | null;
  is_backorder: boolean | null;
  received_by?: string | null;
  contact: SalesDeliveryNoteContactRow | null;
  received_by_contact?: { name: string | null } | null;
  delivery_proofs?: Array<{ received_by_name: string | null; received_at: string | null }> | null;
  business?: { id: string; name?: string | null; base_currency?: string | null } | null;
  carrier?: { name: string | null; tracking_url_template: string | null } | null;
  backorder_of?: { delivery_number: string | null } | null;
  items: SalesDeliveryNoteItemRow[] | null;
}

/** Async-resolved values the pure builder cannot look up itself. */
export interface SalesDeliveryNoteResolved {
  /** profiles.full_name for `dispatch_officer_id`, when present. */
  dispatchOfficerName?: string | null;
  /** profiles.full_name for `received_by_user_id`, when present. */
  receivedByUserName?: string | null;
  /** Fallback currency when the business carries none. */
  fallbackCurrency?: string | null;
}

export interface BuildSalesDeliveryNoteSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: string;
  sourceDocId: string;
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Never print a raw id where a human name belongs. */
function humanName(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || UUID_RE.test(trimmed)) return null;
  return trimmed;
}

/** Strips retired auto-creation tokens the DN automation used to append. */
export function stripAutomationTokens(notes: string | null): string | null {
  if (typeof notes !== "string") return notes ?? null;
  return (
    notes
      .replace(
        /\s*Auto-created from invoice [^[\n]*\[auto-from-invoice:[0-9a-fA-F-]{36}\]\s*(\(backfill\))?\s*/g,
        "",
      )
      .replace(/\s*\[auto-from-invoice:[0-9a-fA-F-]{36}\]\s*/g, "")
      .trim() || null
  );
}

/**
 * Deterministic: lines keep their supplied order and no wall-clock value
 * is introduced, so repeat calls produce byte-identical output — which
 * is what keeps `ensure_document_record`'s upsert idempotent across
 * retry and reprint.
 */
export function buildSalesDeliveryNoteSnapshot(
  dn: SalesDeliveryNoteHeaderRow,
  resolved: SalesDeliveryNoteResolved = {},
): BuildSalesDeliveryNoteSnapshotResult {
  if (!dn.id) throw new Error("buildSalesDeliveryNoteSnapshot: dn.id required");
  if (!dn.delivery_number) {
    throw new Error("buildSalesDeliveryNoteSnapshot: delivery_number required");
  }
  if (!dn.delivery_date) {
    throw new Error("buildSalesDeliveryNoteSnapshot: delivery_date required");
  }

  const currency =
    dn.business?.base_currency || resolved.fallbackCurrency || "KES";

  const trackingUrl =
    dn.carrier?.tracking_url_template && dn.tracking_number
      ? String(dn.carrier.tracking_url_template).replace(
          "{tracking_number}",
          encodeURIComponent(dn.tracking_number),
        )
      : null;

  const podName = Array.isArray(dn.delivery_proofs)
    ? dn.delivery_proofs[0]?.received_by_name ?? null
    : null;

  const receivedByName =
    humanName(dn.received_by_contact?.name) ??
    humanName(podName) ??
    humanName(resolved.receivedByUserName) ??
    humanName(dn.received_by) ??
    null;

  const items = (dn.items ?? []).map((item) => ({
    description: item.description,
    quantity: Number(item.quantity_ordered ?? 0),
    quantity_delivered:
      item.quantity_delivered == null ? null : Number(item.quantity_delivered),
    // Goods document: amounts are structurally zeroed, not merely hidden.
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
    // Pack provenance — the renderers (PDF LineItemsTable, receipt)
    // branch on these; omitting them prints base qty with an
    // invented "ea" unit.
    display_quantity: item.display_quantity ?? null,
    packaging_label: item.packaging_label ?? null,
    base_uom_label: item.base_uom_label ?? null,
    uom_snapshot: item.uom_snapshot ?? null,
  }));

  const snapshot: SnapshotBlob = {
    document_type: "delivery_note",
    document_type_label: "DELIVERY NOTE",
    document_number: dn.delivery_number,
    status: dn.status,
    issue_date: dn.delivery_date,
    subtotal: 0,
    tax_amount: 0,
    discount_amount: 0,
    total: 0,
    currency,
    notes: stripAutomationTokens(dn.notes),
    terms: null,
    contact: dn.contact,
    business_id: dn.business_id,
    organization_id: dn.organization_id,
    branch_id: dn.branch_id,
    shipping_address: dn.shipping_address ?? null,
    items,
    hide_amounts: true,
    driver_name: dn.driver_name ?? null,
    vehicle_number: dn.vehicle_number ?? null,
    shipping_method: dn.shipping_method ?? null,
    carrier_name: dn.carrier?.name ?? null,
    carrier_tracking_url: trackingUrl,
    tracking_number: dn.tracking_number ?? null,
    dispatch_route: dn.dispatch_route ?? null,
    dispatch_officer_name: resolved.dispatchOfficerName ?? null,
    dispatched_at: dn.dispatched_at ?? null,
    delivered_at: dn.delivered_at ?? null,
    ready_at: dn.ready_at ?? null,
    freight_cost: dn.freight_cost ?? null,
    freight_currency: dn.freight_currency ?? null,
    received_by_name: receivedByName,
    is_backorder: !!dn.is_backorder,
    backorder_of_number: dn.backorder_of?.delivery_number ?? null,
  };

  return {
    snapshot,
    documentNumber: dn.delivery_number,
    documentDate: dn.delivery_date.slice(0, 10),
    organizationId: dn.organization_id,
    businessId: dn.business_id,
    branchId: dn.branch_id,
    currency,
    sourceDocId: dn.id,
  };
}

/**
 * Loads exactly what the pure builder needs, resolves the two profile
 * lookups the schema has no FK for, and delegates.
 */
export async function fetchAndBuildSalesDeliveryNoteSnapshot(
  supabase: SupabaseClient,
  deliveryNoteId: string,
): Promise<BuildSalesDeliveryNoteSnapshotResult> {
  const { data, error } = await supabase
    .from("delivery_notes")
    .select(
      `
      id, delivery_number, status, delivery_date, notes,
      organization_id, business_id, branch_id,
      shipping_address, driver_name, vehicle_number,
      shipping_method, tracking_number, dispatch_route,
      dispatch_officer_id, dispatched_at, delivered_at, ready_at,
      freight_cost, freight_currency, is_backorder,
      received_by, received_by_user_id,
      contact:contacts!delivery_notes_contact_id_fkey(name, email, phone, address_line1, city, state, postal_code),
      received_by_contact:contacts!received_by_contact_id(name),
      delivery_proofs(received_by_name, received_at),
      business:businesses(id, name, base_currency),
      carrier:carriers(name, tracking_url_template),
      backorder_of:delivery_notes!backorder_of_dn_id(delivery_number),
      items:delivery_note_items(
        description, quantity_ordered, quantity_delivered,
        display_quantity, uom_snapshot,
        packaging:product_packaging!packaging_id(name, qty_in_base_uom),
        display_uom:units_of_measure!display_uom_id(code, name),
        product:products(sku, base_uom:units_of_measure!base_uom_id(code, name))
      )
      `,
    )
    .eq("id", deliveryNoteId)
    .single();

  if (error || !data) {
    throw new Error(
      `fetchAndBuildSalesDeliveryNoteSnapshot: delivery note ${deliveryNoteId} not found: ${
        error?.message ?? "no row"
      }`,
    );
  }

  const row = normalizeSnapshotItems(data as Record<string, unknown>, "items") as unknown as SalesDeliveryNoteHeaderRow & {
    dispatch_officer_id?: string | null;
    received_by_user_id?: string | null;
  };

  let dispatchOfficerName: string | null = null;
  if (row.dispatch_officer_id) {
    const { data: prof } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("user_id", row.dispatch_officer_id)
      .maybeSingle();
    dispatchOfficerName = (prof as { full_name?: string | null } | null)?.full_name ?? null;
  }

  const podName = Array.isArray(row.delivery_proofs)
    ? row.delivery_proofs[0]?.received_by_name ?? null
    : null;
  let receivedByUserName: string | null = null;
  if (row.received_by_user_id && !row.received_by_contact?.name && !podName) {
    const { data: rprof } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("user_id", row.received_by_user_id)
      .maybeSingle();
    receivedByUserName = (rprof as { full_name?: string | null } | null)?.full_name ?? null;
  }

  return buildSalesDeliveryNoteSnapshot(row, {
    dispatchOfficerName,
    receivedByUserName,
  });
}
