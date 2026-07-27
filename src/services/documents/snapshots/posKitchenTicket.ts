/**
 * Wave 7.2 — POS kitchen ticket snapshot builder.
 *
 * Converts a `pos_kitchen_orders` row (or a grouped set of rows for one
 * table + station) into the JSON blob the shared renderer expects for
 * `document_kinds.code = 'pos.kitchen_ticket'`.
 *
 * Kitchen tickets are ESC/POS thermal artefacts with distinct cut/beep
 * semantics from customer receipts — see the kitchen-ticket golden
 * fixture that gates Wave 7.2 POS commits.
 */
import type { SnapshotBlob } from "./index";

export interface KitchenOrderRow {
  id: string;
  transaction_id: string | null;
  transaction_item_id?: string | null;
  printer_category: string;
  priority?: number | null;
  notes?: string | null;
  table_number?: string | null;
  created_at: string;
  business_id?: string | null;
  branch_id?: string | null;
  organization_id: string;
  transaction?: { transaction_number?: string | null } | null;
}

export interface BuildKitchenTicketSnapshotInput {
  /** All orders in the ticket group (one line per row). */
  orders: KitchenOrderRow[];
  /** The station this ticket is being routed to (kitchen / bar / grill / dessert). */
  station: string;
  /** Optional table override; falls back to `orders[0].table_number`. */
  table?: string | null;
}

export interface BuildKitchenTicketSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string | null;
  documentDate: string;
  businessId: string | null;
  branchId: string | null;
  organizationId: string;
  sourceDocId: string;
}

/**
 * Deterministic snapshot: sorting orders by id keeps repeat calls
 * (retry, reprint) byte-identical so `ensureDocumentRecord`'s idempotency
 * upsert is stable.
 */
export function buildKitchenTicketSnapshot(
  input: BuildKitchenTicketSnapshotInput,
): BuildKitchenTicketSnapshotResult {
  if (input.orders.length === 0) {
    throw new Error("buildKitchenTicketSnapshot: orders must not be empty");
  }
  const sorted = [...input.orders].sort((a, b) => a.id.localeCompare(b.id));
  const first = sorted[0];
  const table = input.table ?? first.table_number ?? null;
  const rush = sorted.some((o) => (o.priority ?? 0) > 0);
  const earliest = sorted.reduce<string>((acc, o) => {
    return !acc || o.created_at < acc ? o.created_at : acc;
  }, "");
  const documentNumber =
    first.transaction?.transaction_number ?? first.id.slice(0, 8);

  const snapshot: SnapshotBlob = {
    document_type: "kitchen_ticket",
    document_type_label: rush ? "RUSH — KITCHEN" : "KITCHEN",
    document_number: documentNumber,
    issue_date: earliest,
    station: input.station,
    table,
    rush,
    // Kitchen tickets do not carry money — no totals / payments / tax.
    items: sorted.map((o, idx) => ({
      seq: idx + 1,
      transaction_item_id: o.transaction_item_id ?? null,
      station: o.printer_category,
      note: o.notes ?? null,
    })),
    notes: sorted
      .map((o) => o.notes)
      .filter((n): n is string => Boolean(n))
      .join(" · ") || null,
  };

  return {
    snapshot,
    documentNumber,
    documentDate: earliest ? earliest.slice(0, 10) : new Date().toISOString().slice(0, 10),
    businessId: first.business_id ?? null,
    branchId: first.branch_id ?? null,
    organizationId: first.organization_id,
    sourceDocId: first.transaction_id ?? first.id,
  };
}
