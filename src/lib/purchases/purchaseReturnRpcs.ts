/**
 * purchaseReturnRpcs — the only way the browser mutates a Purchase Return.
 *
 * `purchase_returns` / `purchase_return_items` are SELECT-only for the
 * `authenticated` role. Every state transition lives in a SECURITY DEFINER,
 * business-scoped, atomic command that:
 *   - validates the transition and the returnable quantity against the
 *     originating goods-receipt line (`purchase_return_returnable_lines`),
 *   - stamps lifecycle actors/timestamps and bumps `row_version`
 *     (optimistic concurrency — every command takes the version it read),
 *   - writes an append-only `purchase_return_events` row,
 *   - emits a `procurement.purchase_return.*` outbox event.
 *
 * Approval is routed through the canonical governance engine
 * (`approval_route('purchase_return.approve', …)`). When a policy gates the
 * action, `purchase_return_submit` returns `gated: true` and the decision is
 * taken in the approvals inbox; `_mirror_approval_to_purchase_return` mirrors
 * it back onto the return. `purchase_return_approve` is the ungated path and
 * still enforces segregation of duties server-side.
 *
 * Never reintroduce a client-side stock movement, journal line, debit-note
 * insert or return-number generator: dispatch owns the stock ledger and
 * `purchase_return_raise_credit` owns the vendor debit note.
 */
import { supabase } from "@/integrations/supabase/client";

export type PurchaseReturnStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "dispatched"
  | "acknowledged"
  | "credited"
  | "closed"
  | "cancelled";

export type PurchaseReturnKind = "goods" | "financial";

/** Structured reason codes — free text stays available as `reason`. */
export const PURCHASE_RETURN_REASON_CODES = [
  { value: "damaged", label: "Damaged in transit" },
  { value: "defective", label: "Defective / quality reject" },
  { value: "wrong_item", label: "Wrong item supplied" },
  { value: "over_delivery", label: "Over-delivery" },
  { value: "expired", label: "Expired / short shelf life" },
  { value: "not_ordered", label: "Not ordered" },
  { value: "price_dispute", label: "Price or billing dispute" },
  { value: "other", label: "Other" },
] as const;

export function reasonCodeLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return (
    PURCHASE_RETURN_REASON_CODES.find((r) => r.value === code)?.label ?? code
  );
}

/**
 * One line of a return. For a goods return `goods_receipt_item_id` is
 * mandatory — the server refuses a goods line with no receipt provenance and
 * prices it from the receipt's landed cost, ignoring any price sent here.
 */
export interface PurchaseReturnLineInput {
  goods_receipt_item_id?: string | null;
  product_id?: string | null;
  bill_item_id?: string | null;
  description?: string | null;
  quantity: number;
  /** Only honoured for `financial` returns; goods lines use receipt cost. */
  unit_price?: number | null;
  tax_rate?: number | null;
  return_reason?: string | null;
  condition?: string | null;
  lot_number?: string | null;
  serial_number?: string | null;
  location_id?: string | null;
  packaging_id?: string | null;
  display_quantity?: number | null;
  display_uom_id?: string | null;
}

export interface ReturnableReceiptLine {
  goods_receipt_item_id: string;
  product_id: string | null;
  description: string;
  lot_number: string | null;
  serial_number: string | null;
  quantity_received: number;
  quantity_returned: number;
  quantity_returnable: number;
  unit_cost: number;
  packaging_id: string | null;
  display_uom_id: string | null;
  uom_snapshot: string | null;
}

async function unwrap(res: { data: unknown; error: unknown }) {
  if (res.error) throw res.error;
  const data = res.data as Record<string, unknown> | null;
  if (data && typeof data === "object" && "success" in data && !data.success) {
    throw new Error((data.error as string) ?? "Operation failed");
  }
  return data;
}

const rpc = (name: string, args: Record<string, unknown>) =>
  (supabase as unknown as {
    rpc: (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  }).rpc(name, args);

/** The remaining-returnable ledger for one goods receipt, net of prior returns. */
export async function fetchReturnableReceiptLines(
  goodsReceiptId: string,
): Promise<ReturnableReceiptLine[]> {
  const { data, error } = await rpc("purchase_return_returnable_lines", {
    _goods_receipt_id: goodsReceiptId,
  });
  if (error) throw error;
  return ((data as ReturnableReceiptLine[] | null) ?? []).map((l) => ({
    ...l,
    quantity_received: Number(l.quantity_received) || 0,
    quantity_returned: Number(l.quantity_returned) || 0,
    quantity_returnable: Number(l.quantity_returnable) || 0,
    unit_cost: Number(l.unit_cost) || 0,
  }));
}

export interface CreatePurchaseReturnInput {
  businessId: string;
  vendorId: string;
  lines: PurchaseReturnLineInput[];
  returnKind?: PurchaseReturnKind;
  goodsReceiptId?: string | null;
  billId?: string | null;
  warehouseId?: string | null;
  returnDate?: string | null;
  reasonCode?: string | null;
  reason?: string | null;
  notes?: string | null;
}

export async function createPurchaseReturn(input: CreatePurchaseReturnInput) {
  const data = await unwrap(
    await rpc("purchase_return_create", {
      _business_id: input.businessId,
      _vendor_id: input.vendorId,
      _lines: input.lines,
      _return_kind: input.returnKind ?? "goods",
      _goods_receipt_id: input.goodsReceiptId ?? null,
      _bill_id: input.billId ?? null,
      _warehouse_id: input.warehouseId ?? null,
      _return_date: input.returnDate ?? null,
      _reason_code: input.reasonCode ?? null,
      _reason: input.reason ?? null,
      _notes: input.notes ?? null,
    }),
  );
  return data as { id: string; return_number: string; totals: Record<string, number> };
}

export async function updatePurchaseReturnDraft(input: {
  id: string;
  rowVersion: number;
  lines: PurchaseReturnLineInput[];
  vendorId?: string | null;
  returnDate?: string | null;
  reasonCode?: string | null;
  reason?: string | null;
  notes?: string | null;
}) {
  return unwrap(
    await rpc("purchase_return_update_draft", {
      _id: input.id,
      _row_version: input.rowVersion,
      _lines: input.lines,
      _vendor_id: input.vendorId ?? null,
      _return_date: input.returnDate ?? null,
      _reason_code: input.reasonCode ?? null,
      _reason: input.reason ?? null,
      _notes: input.notes ?? null,
    }),
  );
}

/** draft → submitted, then routes governance. `gated` tells the UI who decides. */
export async function submitPurchaseReturn(id: string, rowVersion: number) {
  return (await unwrap(
    await rpc("purchase_return_submit", { _id: id, _row_version: rowVersion }),
  )) as { gated?: boolean; approval_request_id?: string | null } | null;
}

export async function approvePurchaseReturn(
  id: string,
  rowVersion: number,
  comment?: string | null,
) {
  return unwrap(
    await rpc("purchase_return_approve", {
      _id: id,
      _row_version: rowVersion,
      _comment: comment ?? null,
    }),
  );
}

export async function rejectPurchaseReturn(id: string, rowVersion: number, reason: string) {
  return unwrap(
    await rpc("purchase_return_reject", {
      _id: id,
      _row_version: rowVersion,
      _reason: reason,
    }),
  );
}

/** approved → dispatched. This is the only place stock leaves the warehouse. */
export async function dispatchPurchaseReturn(input: {
  id: string;
  rowVersion: number;
  dispatchDate?: string | null;
  trackingReference?: string | null;
}) {
  return (await unwrap(
    await rpc("purchase_return_dispatch", {
      _id: input.id,
      _row_version: input.rowVersion,
      _dispatch_date: input.dispatchDate ?? null,
      _tracking_reference: input.trackingReference ?? null,
    }),
  )) as { stock_movements?: number } | null;
}

/** dispatched → acknowledged: the supplier confirmed receipt / issued an RMA. */
export async function acknowledgePurchaseReturn(input: {
  id: string;
  rowVersion: number;
  rmaReference?: string | null;
  notes?: string | null;
}) {
  return unwrap(
    await rpc("purchase_return_acknowledge", {
      _id: input.id,
      _row_version: input.rowVersion,
      _rma_reference: input.rmaReference ?? null,
      _notes: input.notes ?? null,
    }),
  );
}

/** Raises + issues the vendor debit note (credit note against the supplier). */
export async function raisePurchaseReturnCredit(id: string, rowVersion: number) {
  return (await unwrap(
    await rpc("purchase_return_raise_credit", { _id: id, _row_version: rowVersion }),
  )) as { vendor_credit_note_id?: string | null; already?: boolean } | null;
}

export async function closePurchaseReturn(id: string, rowVersion: number) {
  return unwrap(
    await rpc("purchase_return_close", { _id: id, _row_version: rowVersion }),
  );
}

export async function cancelPurchaseReturn(
  id: string,
  rowVersion: number,
  reason?: string | null,
) {
  return unwrap(
    await rpc("purchase_return_cancel", {
      _id: id,
      _row_version: rowVersion,
      _reason: reason ?? null,
    }),
  );
}
