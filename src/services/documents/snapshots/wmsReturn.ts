/**
 * Returns (RMA) snapshot builder — Phase 6 of the Warehouse Returns rebuild.
 *
 * One builder serves the four returns paperwork kinds because they share a
 * single source aggregate (`wms_return_orders` + `wms_return_lines`) and differ
 * only in which lens they put on it:
 *
 *   - `wms.rma_authorization` — what the party is authorised to send back.
 *   - `wms.return_receipt`    — what physically arrived at the dock.
 *   - `wms.inspection_report` — condition + inspection outcome per line.
 *   - `wms.damage_report`     — damaged / defective lines only, with evidence counts.
 *
 * Returns paperwork is QUANTITY-ONLY, exactly like the GRN: valuation belongs
 * to Finance (`sales_returns` / `purchase_returns` and the credit note), never
 * to a warehouse document. Every monetary field is therefore a hard zero.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SnapshotBlob } from "./index";

export type ReturnDocumentKind =
  | "wms.rma_authorization"
  | "wms.return_receipt"
  | "wms.inspection_report"
  | "wms.damage_report";

export const RETURN_DOCUMENT_LABEL: Record<ReturnDocumentKind, string> = {
  "wms.rma_authorization": "RMA AUTHORIZATION",
  "wms.return_receipt": "RETURN RECEIPT",
  "wms.inspection_report": "RETURN INSPECTION REPORT",
  "wms.damage_report": "RETURN DAMAGE REPORT",
};

const DOCUMENT_TYPE: Record<ReturnDocumentKind, string> = {
  "wms.rma_authorization": "rma_authorization",
  "wms.return_receipt": "return_receipt",
  "wms.inspection_report": "return_inspection_report",
  "wms.damage_report": "return_damage_report",
};

const DAMAGE_CONDITIONS = new Set(["damaged", "defective", "expired"]);

export interface ReturnSnapshotPartyRow {
  name: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
}

export interface ReturnSnapshotLineRow {
  id: string;
  product_id: string | null;
  lot_number: string | null;
  serial_number: string | null;
  uom: string | null;
  expected_qty: number | null;
  received_qty: number | null;
  restock_qty: number | null;
  quarantine_qty: number | null;
  scrap_qty: number | null;
  condition_code: string | null;
  inspection_state: string | null;
  disposition: string | null;
  photo_count: number | null;
  notes: string | null;
  created_at: string;
  products?: { name: string | null; sku: string | null } | null;
}

export interface ReturnSnapshotHeaderRow {
  id: string;
  code: string;
  rma_reference: string | null;
  return_kind: string;
  state: string;
  organization_id: string;
  business_id: string;
  branch_id: string | null;
  warehouse_id: string;
  customer_id: string | null;
  vendor_id: string | null;
  tracking_reference: string | null;
  notes: string | null;
  expected_at: string | null;
  received_at: string | null;
  created_at: string;
  customer?: ReturnSnapshotPartyRow | null;
  vendor?: ReturnSnapshotPartyRow | null;
  lines?: ReturnSnapshotLineRow[] | null;
}

export interface BuildReturnSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: string;
  sourceDocId: string;
  partyKind: "customer" | "supplier" | null;
  partyId: string | null;
}

function num(value: number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function humanize(value: string | null | undefined): string {
  return value ? value.replace(/_/g, " ") : "";
}

/** Which quantity the document is about — authorised, received, or inspected. */
function documentQuantity(kind: ReturnDocumentKind, line: ReturnSnapshotLineRow): number {
  if (kind === "wms.rma_authorization") return num(line.expected_qty);
  return num(line.received_qty);
}

export function buildReturnDocumentSnapshot(
  order: ReturnSnapshotHeaderRow,
  kind: ReturnDocumentKind,
): BuildReturnSnapshotResult {
  if (!order.id) throw new Error("buildReturnDocumentSnapshot: order.id required");
  if (!order.code) throw new Error("buildReturnDocumentSnapshot: order.code required");

  const allLines = order.lines ?? [];
  const scoped =
    kind === "wms.damage_report"
      ? allLines.filter((l) => DAMAGE_CONDITIONS.has(l.condition_code ?? ""))
      : allLines;

  const items = scoped.map((line) => {
    const detail: string[] = [];
    if (line.lot_number) detail.push(`Lot ${line.lot_number}`);
    if (line.serial_number) detail.push(`S/N ${line.serial_number}`);
    if (kind !== "wms.rma_authorization" && line.condition_code) {
      detail.push(`Condition: ${humanize(line.condition_code)}`);
    }
    if (kind === "wms.inspection_report" || kind === "wms.damage_report") {
      if (line.inspection_state) detail.push(`Inspection: ${humanize(line.inspection_state)}`);
      if (line.disposition) detail.push(`Disposition: ${humanize(line.disposition)}`);
      const photos = num(line.photo_count);
      if (photos > 0) detail.push(`${photos} photo(s) on file`);
    }
    if (kind === "wms.return_receipt") {
      const buckets: string[] = [];
      if (num(line.restock_qty)) buckets.push(`restock ${num(line.restock_qty)}`);
      if (num(line.quarantine_qty)) buckets.push(`quarantine ${num(line.quarantine_qty)}`);
      if (num(line.scrap_qty)) buckets.push(`scrap ${num(line.scrap_qty)}`);
      if (buckets.length) detail.push(buckets.join(" · "));
    }
    if (line.notes) detail.push(line.notes);

    const name = line.products?.name ?? "Returned item";
    const sku = line.products?.sku ? ` (${line.products.sku})` : "";

    return {
      description: detail.length ? `${name}${sku} — ${detail.join(" · ")}` : `${name}${sku}`,
      quantity: documentQuantity(kind, line),
      // Quantity-only document — see file header.
      unit_price: 0,
      tax_rate: 0,
      tax_amount: 0,
      line_total: 0,
      display_quantity: null,
      packaging_label: null,
      base_uom_label: line.uom ?? "ea",
      uom_snapshot: line.uom ?? null,
    };
  });

  const isVendor = order.return_kind === "vendor";
  const party = isVendor ? order.vendor ?? null : order.customer ?? null;
  const partyId = isVendor ? order.vendor_id : order.customer_id;

  const documentDateSource =
    kind === "wms.rma_authorization"
      ? order.created_at
      : order.received_at ?? order.created_at;

  const referenceBits = [
    order.rma_reference ? `RMA ${order.rma_reference}` : null,
    order.tracking_reference ? `Tracking ${order.tracking_reference}` : null,
  ].filter(Boolean);

  const snapshot: SnapshotBlob = {
    document_type: DOCUMENT_TYPE[kind],
    document_type_label: RETURN_DOCUMENT_LABEL[kind],
    document_number: order.code,
    status: order.state,
    issue_date: documentDateSource,
    due_date: null,
    subtotal: 0,
    tax_amount: 0,
    discount_amount: 0,
    total: 0,
    currency: "USD",
    notes: order.notes ?? null,
    terms: null,
    contact: party,
    business_id: order.business_id,
    organization_id: order.organization_id,
    branch_id: order.branch_id,
    shipping_address: null,
    reference: referenceBits.length ? referenceBits.join(" · ") : null,
    items,
  };

  return {
    snapshot,
    documentNumber: order.code,
    documentDate: (documentDateSource ?? order.created_at).slice(0, 10),
    organizationId: order.organization_id,
    businessId: order.business_id,
    branchId: order.branch_id,
    currency: "USD",
    sourceDocId: order.id,
    partyKind: partyId ? (isVendor ? "supplier" : "customer") : null,
    partyId: partyId ?? null,
  };
}

export async function fetchAndBuildReturnDocumentSnapshot(
  supabase: SupabaseClient,
  returnId: string,
  kind: ReturnDocumentKind,
): Promise<BuildReturnSnapshotResult> {
  const { data, error } = await supabase
    .from("wms_return_orders" as never)
    .select(
      `
      id, code, rma_reference, return_kind, state,
      organization_id, business_id, branch_id, warehouse_id,
      customer_id, vendor_id, tracking_reference, notes,
      expected_at, received_at, created_at,
      lines:wms_return_lines(
        id, product_id, lot_number, serial_number, uom,
        expected_qty, received_qty, restock_qty, quarantine_qty, scrap_qty,
        condition_code, inspection_state, disposition, photo_count, notes, created_at,
        products(name, sku)
      )
      `,
    )
    .eq("id", returnId)
    .maybeSingle();

  if (error || !data) {
    throw new Error(
      `fetchAndBuildReturnDocumentSnapshot: return ${returnId} not found: ${error?.message ?? "no row"}`,
    );
  }

  const order = data as unknown as ReturnSnapshotHeaderRow;

  // `wms_return_orders` carries no FK to `contacts` (the party may be a
  // customer or a vendor), so the party block is resolved with a second read
  // rather than a PostgREST embed.
  const partyId = order.return_kind === "vendor" ? order.vendor_id : order.customer_id;
  if (partyId) {
    const { data: party } = await supabase
      .from("contacts")
      .select("name, email, phone, address_line1, city, state, postal_code")
      .eq("id", partyId)
      .maybeSingle();
    const row = (party ?? null) as ReturnSnapshotPartyRow | null;
    if (order.return_kind === "vendor") order.vendor = row;
    else order.customer = row;
  }

  return buildReturnDocumentSnapshot(order, kind);
}
