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

import type { WmsTopic } from '@/features/warehouse/events/topics';

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
  // Stock Event Fabric (ADR 0076, consolidated in the Inventory Foundation
  // Wave · Phase 6). ONE emitter — `tg_stock_movement_emit_event` — publishes
  // exactly one `inventory.movement.recorded` row per stock_movements INSERT,
  // with `movement_class` (received/dispatched/transferred/adjusted/posted)
  // in the payload. The five legacy `stock.movement.*` topics are retired.
  | 'inventory.movement.recorded'
  // Inventory lot / serial / valuation lifecycle (Phase 6).
  | 'inventory.lot.quarantined'
  | 'inventory.lot.released'
  | 'inventory.lot.recall_opened'
  | 'inventory.lot.recall_closed'
  | 'inventory.serial.status_changed'
  | 'inventory.valuation.revalued'
  | 'inventory.valuation.revaluation_reversed'
  // Non-movement stock lifecycle (Session 8 · Priority B). Emitted by
  // DB triggers on stock_adjustments, stock_transfers, physical_counts.
  | 'stock.adjustment.posted'
  | 'stock.transfer.approved'
  | 'stock.transfer.completed'
  | 'stock.count.completed'
  | 'stock.count.cancelled'
  // Warehouse (WMS). The canonical topic vocabulary lives in
  // `src/features/warehouse/events/topics.ts` and mirrors the
  // `wms_events_catalog` table — never re-declare warehouse topics here.
  | WmsTopic;


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
