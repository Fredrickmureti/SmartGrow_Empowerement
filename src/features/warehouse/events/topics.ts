/**
 * Warehouse event topic catalog (ADR 0101 — Phase 1).
 *
 * Every `warehouse.*` topic emitted to `business_event_outbox` is declared
 * here, alongside its producers, consumers, payload shape, and idempotency
 * key shape. Runtime code MUST reference these constants instead of raw
 * strings so producers and consumers cannot drift.
 *
 * Mirrored in the `wms_events_catalog` DB table (seeded in the Phase 1.1
 * migration). Keep the two in sync — the SQL table is the runtime source
 * of truth for observability tooling; this file is the source of truth
 * for the TypeScript layer.
 */

export const WMS_TOPIC = {
  // ---- Task lifecycle -------------------------------------------------
  TASK_AVAILABLE: "warehouse.task.available",
  TASK_ASSIGNED: "warehouse.task.assigned",
  TASK_CLAIMED: "warehouse.task.claimed",
  TASK_IN_PROGRESS: "warehouse.task.in_progress",
  TASK_PAUSED: "warehouse.task.paused",
  TASK_RESUMED: "warehouse.task.resumed",
  TASK_COMPLETED: "warehouse.task.completed",
  TASK_EXCEPTION: "warehouse.task.exception",
  TASK_CANCELLED: "warehouse.task.cancelled",

  // ---- LPN lifecycle --------------------------------------------------
  LPN_RECEIVING: "warehouse.lpn.receiving",
  LPN_PUTAWAY: "warehouse.lpn.putaway",
  LPN_STORED: "warehouse.lpn.stored",
  LPN_PICKED: "warehouse.lpn.picked",
  LPN_PACKED: "warehouse.lpn.packed",
  LPN_SEALED: "warehouse.lpn.sealed",
  LPN_STAGED: "warehouse.lpn.staged",
  LPN_LOADED: "warehouse.lpn.loaded",
  LPN_SHIPPED: "warehouse.lpn.shipped",
  LPN_QUARANTINED: "warehouse.lpn.quarantined",
  LPN_MOVED: "warehouse.lpn.moved",
  LPN_VOIDED: "warehouse.lpn.voided",

  // ---- Cartons (pack station -> manifest -> dispatch) -----------------
  CARTON_OPENED: "warehouse.carton.opened",
  CARTON_SEALED: "warehouse.carton.sealed",
  CARTON_LOADED: "warehouse.carton.loaded",
  CARTON_SHIPPED: "warehouse.carton.shipped",

  // ---- Receiving ------------------------------------------------------
  RECEIVING_OPENED: "warehouse.receiving.opened",
  RECEIVING_LINE_CAPTURED: "warehouse.receiving.line_captured",
  RECEIVING_CLOSED: "warehouse.receiving.closed",
  RECEIVING_DISCREPANT: "warehouse.receiving.discrepant",
  RECEIPT_STAGED: "warehouse.receipt.staged",

  // ---- Returns --------------------------------------------------------
  // Header FSM: wms_transition_return emits 'warehouse.return.' || state.
  RETURN_DRAFT: "warehouse.return.draft",
  RETURN_AUTHORIZED: "warehouse.return.authorized",
  RETURN_IN_TRANSIT: "warehouse.return.in_transit",
  RETURN_RECEIVED: "warehouse.return.received",
  RETURN_INSPECTING: "warehouse.return.inspecting",
  RETURN_DISPOSED: "warehouse.return.disposed",
  RETURN_CLOSED: "warehouse.return.closed",
  RETURN_CANCELLED: "warehouse.return.cancelled",
  // Line-level execution topics (returns execution RPCs).
  RETURN_LINE_CAPTURED: "warehouse.return.line_captured",
  RETURN_LINE_INSPECTED: "warehouse.return.line_inspected",
  RETURN_LINE_DISPOSITIONED: "warehouse.return.line_dispositioned",
  RETURN_DISPOSITIONS_POSTED: "warehouse.return.dispositions_posted",
  RETURN_BLOCKED: "warehouse.return.blocked",
  /** Finance doc (credit note / sales or purchase return) attached to the RMA. */
  RETURN_FINANCE_LINKED: "warehouse.return.finance_linked",




  // ---- Exception inbox ------------------------------------------------
  EXCEPTION_RAISED: "warehouse.exception.raised",
  EXCEPTION_RESOLVED: "warehouse.exception.resolved",

  // ---- Pick waves (Phase 2.4 §2 — wms_transition_wave) ----------------
  WAVE_DRAFT: "warehouse.wave.draft",
  WAVE_RELEASED: "warehouse.wave.released",
  WAVE_PICKING: "warehouse.wave.picking",
  WAVE_PICKED: "warehouse.wave.picked",
  WAVE_PACKING: "warehouse.wave.packing",
  WAVE_PACKED: "warehouse.wave.packed",
  WAVE_CANCELLED: "warehouse.wave.cancelled",
  WAVE_REOPENED: "warehouse.wave.reopened",

  // ---- Loading manifests (wms_transition_manifest) --------------------
  MANIFEST_DRAFT: "warehouse.manifest.draft",
  MANIFEST_LOADING: "warehouse.manifest.loading",
  MANIFEST_CLOSED: "warehouse.manifest.closed",
  MANIFEST_DISPATCHED: "warehouse.manifest.dispatched",
  MANIFEST_CANCELLED: "warehouse.manifest.cancelled",

  // ---- QC inspections (wms_transition_qc) -----------------------------
  QC_PENDING: "warehouse.qc.pending",
  QC_IN_PROGRESS: "warehouse.qc.in_progress",
  QC_PASSED: "warehouse.qc.passed",
  QC_FAILED: "warehouse.qc.failed",
  QC_CONDITIONAL: "warehouse.qc.conditional",
  QC_CLOSED: "warehouse.qc.closed",
  QC_CANCELLED: "warehouse.qc.cancelled",

  // ---- Cycle counts (wms_transition_count_session) --------------------
  COUNT_DRAFT: "warehouse.count.draft",
  COUNT_COUNTING: "warehouse.count.counting",
  COUNT_REVIEW: "warehouse.count.review",
  COUNT_RECORDED: "warehouse.count.recorded",
  COUNT_POSTED: "warehouse.count.posted",
  COUNT_CANCELLED: "warehouse.count.cancelled",

  // ---- Yard / trailer visits (trigger-emitted, Phase 2.4 §5) ----------
  TRAILER_ARRIVED: "warehouse.trailer.arrived",
  TRAILER_DOCKED: "warehouse.trailer.docked",
  TRAILER_DEPARTED: "warehouse.trailer.departed",
  TRAILER_NO_SHOW: "warehouse.trailer.no_show",
  /**
   * Phase 5.2 — a no-show cancelled the trailer's open loading manifests,
   * so the `load` tasks booked against them return to the labour queue.
   * Payload: { trailer_visit_id, cancelled_manifests, released_load_tasks }.
   */
  LABOUR_RECLAIMED: "warehouse.labour.reclaimed",

  // ---- Dock appointments ----------------------------------------------
  APPOINTMENT_SCHEDULED: "warehouse.appointment.scheduled",
  APPOINTMENT_ARRIVED: "warehouse.appointment.arrived",
  APPOINTMENT_IN_PROGRESS: "warehouse.appointment.in_progress",
  APPOINTMENT_COMPLETED: "warehouse.appointment.completed",
  APPOINTMENT_CANCELLED: "warehouse.appointment.cancelled",

  // ---- Cross-docking ---------------------------------------------------
  CROSSDOCK_MATCHED: "warehouse.crossdock.matched",
  CROSSDOCK_STAGED: "warehouse.crossdock.staged",
  CROSSDOCK_CANCELLED: "warehouse.crossdock.cancelled",

  // ---- Replenishment (stock_quants trigger, Phase 3.4) ----------------
  REPLEN_ENQUEUED: "warehouse.replen.enqueued",
} as const;

export type WmsTopic = (typeof WMS_TOPIC)[keyof typeof WMS_TOPIC];

/**
 * Topics that exist in `wms_events_catalog` for historic decoding but are
 * emitted by no producer. They are intentionally absent from `WMS_TOPIC` so
 * runtime code cannot subscribe to a dead topic; the parity guard uses this
 * list to reconcile the SQL catalog with the TypeScript catalog in both
 * directions.
 */
export const WMS_DEPRECATED_TOPICS = [
  "warehouse.return.opened",
  "warehouse.return.inspected",
  "warehouse.return.dispositioned",
] as const;


/** Canonical idempotency key shape used across producers. */
export const idempotencyKey = (
  aggregate:
    | "task"
    | "lpn"
    | "carton"
    | "receiving"
    | "return"
    | "exception"
    | "wave"
    | "manifest"
    | "qc"
    | "count"
    | "trailer"
    | "appointment"
    | "crossdock"
    | "replen",
  id: string,
  transition: string,
) => `wms.${aggregate}:${id}:${transition}`;

/** Task types recognised by the polymorphic task engine. */
export const TASK_TYPES = [
  "putaway",
  "pick",
  "pack",
  "load",
  "count",
  "replenish",
  "move",
  "qc",
  "receive",
  "return",
] as const;
export type WmsTaskType = (typeof TASK_TYPES)[number];

/** Task states (post Phase 1 migration). */
export const TASK_STATES = [
  "pending",
  "available",
  "assigned",
  "claimed",
  "in_progress",
  "paused",
  "resumed",
  "done",
  "completed",
  "cancelled",
  "exception",
] as const;
export type WmsTaskState = (typeof TASK_STATES)[number];
