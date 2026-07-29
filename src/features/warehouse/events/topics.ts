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
  TASK_CLAIMED: "warehouse.task.claimed",
  TASK_IN_PROGRESS: "warehouse.task.in_progress",
  TASK_COMPLETED: "warehouse.task.completed",
  TASK_EXCEPTION: "warehouse.task.exception",
  TASK_CANCELLED: "warehouse.task.cancelled",

  // ---- LPN lifecycle --------------------------------------------------
  LPN_RECEIVING: "warehouse.lpn.receiving",
  LPN_PUTAWAY: "warehouse.lpn.putaway",
  LPN_STORED: "warehouse.lpn.stored",
  LPN_PICKED: "warehouse.lpn.picked",
  LPN_PACKED: "warehouse.lpn.packed",
  LPN_STAGED: "warehouse.lpn.staged",
  LPN_LOADED: "warehouse.lpn.loaded",
  LPN_SHIPPED: "warehouse.lpn.shipped",
  LPN_QUARANTINED: "warehouse.lpn.quarantined",
  LPN_VOIDED: "warehouse.lpn.voided",

  // ---- Carton / manifest linkage -------------------------------------
  CARTON_LOADED: "warehouse.carton.loaded",

  // ---- Receiving ------------------------------------------------------
  RECEIVING_OPENED: "warehouse.receiving.opened",
  RECEIVING_LINE_CAPTURED: "warehouse.receiving.line_captured",
  RECEIVING_CLOSED: "warehouse.receiving.closed",
  RECEIVING_DISCREPANT: "warehouse.receiving.discrepant",

  // ---- Returns --------------------------------------------------------
  RETURN_OPENED: "warehouse.return.opened",
  RETURN_INSPECTED: "warehouse.return.inspected",
  RETURN_DISPOSITIONED: "warehouse.return.dispositioned",
  RETURN_CLOSED: "warehouse.return.closed",

  // ---- Exception inbox ------------------------------------------------
  EXCEPTION_RAISED: "warehouse.exception.raised",
  EXCEPTION_RESOLVED: "warehouse.exception.resolved",
} as const;

export type WmsTopic = (typeof WMS_TOPIC)[keyof typeof WMS_TOPIC];

/** Canonical idempotency key shape used across producers. */
export const idempotencyKey = (
  aggregate: "task" | "lpn" | "receiving" | "return" | "exception",
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
  "done",
  "completed",
  "cancelled",
  "exception",
] as const;
export type WmsTaskState = (typeof TASK_STATES)[number];
