/**
 * Stage V5 — centralized delivery-note lifecycle types.
 *
 * The DB CHECK constraint on `delivery_notes.status` is the source of truth;
 * this union mirrors it so client-side switches stay exhaustive when a new
 * state is added. `LIFECYCLE_TRANSITIONS` documents the allowed forward
 * transitions the RPCs accept (for UI gating only — server still enforces).
 */
export type DeliveryNoteStatus =
  | "pending"
  | "ready_to_dispatch"
  | "dispatched"
  | "in_transit"
  | "delivered"
  | "partial"
  | "cancelled";

export const FINAL_DELIVERY_STATUSES: ReadonlySet<DeliveryNoteStatus> =
  new Set(["delivered", "partial", "cancelled"]);

export const LIFECYCLE_TRANSITIONS: Readonly<
  Record<DeliveryNoteStatus, readonly DeliveryNoteStatus[]>
> = {
  pending: ["ready_to_dispatch", "dispatched", "delivered", "partial", "cancelled"],
  ready_to_dispatch: ["dispatched", "delivered", "partial", "cancelled"],
  dispatched: ["in_transit", "delivered", "partial", "cancelled"],
  in_transit: ["delivered", "partial", "cancelled"],
  delivered: [],
  partial: [],
  cancelled: [],
};

export function isFinalDeliveryStatus(s: string | null | undefined): boolean {
  return !!s && FINAL_DELIVERY_STATUSES.has(s as DeliveryNoteStatus);
}