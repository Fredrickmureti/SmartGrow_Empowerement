/**
 * domainEventBus — application-wide pub/sub for business events that
 * may drive hardware, notifications, prints, GL postings, or other
 * downstream side-effects.
 *
 * Renderer-side mirror of the database `business_event_outbox`. UI
 * code may also publish optimistically here for low-latency reactions
 * (e.g. flashing the cart after sale.committed), but the **source of
 * truth is always the outbox row written by a database trigger**.
 *
 * Architectural rule: never `hardwareClient.exec` directly from a
 * domain module in response to a business event. Publish a domain
 * event instead and let BusinessSaga decide which hardware step(s)
 * to fire — that path is durable, retried, and audited.
 */

export type DomainEventType =
  | 'sale.committed'
  | 'goods_receipt.posted'
  | 'stock_transfer.dispatched'
  | 'stock_transfer.received'
  | 'delivery_note.dispatched'
  | 'sales_return.accepted'
  | 'stock_adjustment.approved'
  | 'scrap.posted'
  | 'scrap.reversed'
  | 'product.created'
  | 'asset.capitalised'
  | 'payment.received'
  | 'attendance.clock_in'
  | 'attendance.clock_out'
  | 'attendance.shift_started'
  | 'attendance.shift_ended'
  | 'production_order.completed'
  // Customer-display saga ops.
  | 'pos.cart_total_changed'
  | 'pos.payment_completed'
  | 'pos.session_idle'
  // Stock Event Fabric (ADR 0076). Emitted by DB trigger
  // `tg_stock_movement_emit_event` for every stock_movements INSERT.
  | 'stock.movement.received'
  | 'stock.movement.dispatched'
  | 'stock.movement.transferred'
  | 'stock.movement.adjusted'
  | 'stock.movement.posted'
  // Non-movement stock lifecycle (Session 8 · Priority B). Emitted by
  // DB triggers on stock_adjustments, stock_transfers, physical_counts.
  | 'stock.adjustment.posted'
  | 'stock.transfer.approved'
  | 'stock.transfer.completed'
  | 'stock.count.completed'
  | 'stock.count.cancelled'
  // Warehouse (WMS) — Phase 1. Emitted by DB triggers on wms_tasks and
  // wms_license_plates. See ADR 0079.
  | 'warehouse.task.assigned'
  | 'warehouse.task.available'
  | 'warehouse.task.claimed'
  | 'warehouse.task.in_progress'
  | 'warehouse.task.completed'
  | 'warehouse.task.exception'
  | 'warehouse.task.cancelled'
  | 'warehouse.lpn.moved'
  | 'warehouse.lpn.sealed'
  | 'warehouse.receipt.staged'
  | 'warehouse.putaway.suggested'
  | 'warehouse.putaway.completed'
  // Warehouse (WMS) — Phase 3. Emitted by pick-wave, pick, pack RPCs.
  | 'warehouse.wave.released'
  | 'warehouse.pick.completed'
  | 'warehouse.pack.completed'
  // Warehouse (WMS) — Phase 4b. Per-SO shipment cartons under a wave.
  | 'warehouse.carton.opened'
  | 'warehouse.carton.sealed'
  // Warehouse (WMS) — Phase 4c. Cycle counting.
  | 'warehouse.count.opened'
  | 'warehouse.count.recorded'
  | 'warehouse.count.posted'
  // Warehouse (WMS) — Phase 5. Loading & dispatch.
  | 'warehouse.manifest.opened'
  | 'warehouse.manifest.closed'
  | 'warehouse.manifest.dispatched'
  | 'warehouse.carton.shipped'
  // Warehouse (WMS) — Phase 6. Dock scheduling & appointments.
  | 'warehouse.appointment.scheduled'
  | 'warehouse.appointment.arrived'
  | 'warehouse.appointment.in_progress'
  | 'warehouse.appointment.completed'
  | 'warehouse.appointment.cancelled'
  // Warehouse (WMS) — Phase 7. QC inspection lifecycle.
  | 'warehouse.qc.opened'
  | 'warehouse.qc.accepted'
  | 'warehouse.qc.rejected'
  | 'warehouse.qc.cancelled';

export interface DomainEvent<P = unknown> {
  id?: string;
  type: DomainEventType;
  orgId: string;
  branchId?: string | null;
  warehouseId?: string | null;
  sourceDocType: string;
  sourceDocId: string;
  payload: P;
  occurredAt: string;
}

type Handler = (event: DomainEvent) => void | Promise<void>;

class DomainEventBus {
  private handlers = new Map<DomainEventType | '*', Set<Handler>>();

  on(type: DomainEventType | '*', handler: Handler): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
    return () => {
      set.delete(handler);
    };
  }

  async publish(event: DomainEvent): Promise<void> {
    const direct = this.handlers.get(event.type);
    const wildcard = this.handlers.get('*');
    const all = [...(direct ?? []), ...(wildcard ?? [])];
    await Promise.allSettled(all.map((h) => h(event)));
  }

  /** Test helper. */
  _reset(): void {
    this.handlers.clear();
  }
}

export const domainEventBus = new DomainEventBus();
