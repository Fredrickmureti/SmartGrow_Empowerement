/**
 * BusinessSagaMount — starts a single BusinessSaga worker for the
 * active organization. Mount once at the app root (inside
 * <CountryWorkspaceContext>) so every business event written to the
 * outbox is drained and dispatched on this host.
 *
 * Handler registration belongs in feature modules; this component
 * only wires the lifecycle.
 */

import { useEffect, useRef } from 'react';
import { BusinessSaga } from '@/services/events/BusinessSaga';
import { printLabel, printDocument } from '@/services/printing/PrintService';
import { toDevice } from '@/services/printing/dispatch';
import { domainEventBus, type DomainEvent } from '@/services/events/domainEventBus';
import { customerDisplayClient, type CustomerDisplayData } from '@/services/hardware/local-display/CustomerDisplayClient';
import { reclaimStaleBusinessEvents } from '@/services/events/reclaimStaleEvents';
import { startPrintRecoverySweeper } from '@/services/printing/recovery';
import { useBranches } from '@/hooks/useBranches';
import { useBusinesses } from '@/hooks/useBusinesses';
import { WMS_TOPIC } from '@/features/warehouse/events/topics';
import { supabase } from '@/integrations/supabase/client';



interface Props {
  orgId: string | null | undefined;
}

export function BusinessSagaMount({ orgId }: Props) {
  const { currentBranch } = useBranches();
  const branchId = currentBranch?.id ?? null;
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id ?? null;

  // Customer-display saga (Loop B1). The domain bus is the single writer
  // to `customerDisplayClient`; POSTerminal only emits intent. A small
  // dedupe map collapses bursts from React-effect rerenders so the
  // display sees exactly one update per real cart mutation. Cleared on
  // `pos.session_idle` and on payment completion to keep state honest
  // across cashier sessions.
  const dedupeRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!orgId) return;
    const dedupeWindowMs = 250;
    const shouldDedupe = (key: string) => {
      const now = Date.now();
      const last = dedupeRef.current.get(key) ?? 0;
      if (now - last < dedupeWindowMs) return true;
      dedupeRef.current.set(key, now);
      return false;
    };

    const safe = async (fn: () => Promise<unknown>) => {
      try { await fn(); } catch (err) { console.warn('[customer-display saga]', err); }
    };

    const writeDisplayFromCart = (e: DomainEvent) => {
      const p = (e.payload ?? {}) as {
        items?: Array<{ id?: string; name?: string; quantity?: number; unitPrice?: number; lineTotal?: number }>;
        subtotal?: number;
        tax?: number;
        discount?: number;
        total?: number;
        currency?: string;
        customerName?: string | null;
        itemCount?: number;
      };
      const data: CustomerDisplayData = {
        status: (p.itemCount ?? p.items?.length ?? 0) > 0 ? 'scanning' : 'idle',
        items: (p.items ?? []).map((it) => ({
          id: String(it.id ?? ''),
          name: String(it.name ?? ''),
          quantity: Number(it.quantity ?? 0),
          price: Number(it.unitPrice ?? 0),
          total: Number(it.lineTotal ?? 0),
        })),
        subtotal: Number(p.subtotal ?? 0),
        tax: Number(p.tax ?? 0),
        discount: Number(p.discount ?? 0),
        total: Number(p.total ?? 0),
        currency: p.currency,
        customerName: p.customerName ?? undefined,
      };
      return customerDisplayClient.update(data);
    };

    // Note: per-line events were dropped — `pos.cart_total_changed`
    // carries the authoritative frame and lands in the same tick. If a
    // per-line consumer (audio cue, line label print) is added later,
    // reintroduce `pos.line_added` in the bus + a subscriber here.

    const offCart = domainEventBus.on('pos.cart_total_changed', async (e) => {
      if (shouldDedupe(`cart:${e.sourceDocId}`)) return;
      if (!customerDisplayClient.isDisplayConnected()) return;
      await safe(() => writeDisplayFromCart(e));
    });

    const offPay = domainEventBus.on('pos.payment_completed', async (e) => {
      dedupeRef.current.clear();
      if (!customerDisplayClient.isDisplayConnected()) return;
      const p = (e.payload ?? {}) as { total?: number; customerName?: string | null };
      await safe(async () => {
        await customerDisplayClient.showComplete(Number(p.total ?? 0), p.customerName ?? undefined);
        // Reset back to idle after the thank-you frame so the next sale
        // starts clean. The 5s window matches the legacy POSTerminal
        // behaviour for cashier muscle-memory.
        setTimeout(() => { void customerDisplayClient.reset(); }, 5000);
      });
    });

    const offIdle = domainEventBus.on('pos.session_idle', async () => {
      dedupeRef.current.clear();
      if (!customerDisplayClient.isDisplayConnected()) return;
      await safe(() => customerDisplayClient.reset());
    });

    return () => {
      offCart();
      offPay();
      offIdle();
    };
  }, [orgId]);

  useEffect(() => {
    if (!orgId) return;
    const saga = new BusinessSaga(orgId, 4000, branchId);


    saga.register('goods_receipt.posted', async (e: DomainEvent) => {
      // Print one summary label for the receipt itself …
      await printLabel({
        orgId: e.orgId,
        templateKey: 'grn_summary',
        workflow: 'receiving',
        branchId: e.branchId,
        warehouseId: e.warehouseId,
        vars: { grnId: e.sourceDocId, ...(e.payload as Record<string, unknown>) },
        sourceDocType: e.sourceDocType,
        sourceDocId: e.sourceDocId,
        businessEventId: e.id,
        idempotencyKey: `grn-label:${e.sourceDocId}`,
      });

      // Track 3 — per-lot shelf labels with lot + expiry tokens.
      // Lots live on goods_receipt_items; trigger payload only carries
      // grn_id so we fetch the items here.
      try {
        const { data: items } = await (await import('@/integrations/supabase/client')).supabase
          .from('goods_receipt_items')
          .select('product_id, quantity_received, lot_number')
          .eq('goods_receipt_id', e.sourceDocId);
        for (const item of (items ?? []) as Array<{
          product_id: string | null;
          quantity_received: number | null;
          lot_number: string | null;
        }>) {
          if (!item.product_id) continue;
          await printLabel({
            orgId: e.orgId,
            templateKey: 'shelf_edge',
            workflow: 'shelf_edge',
            branchId: e.branchId,
            warehouseId: e.warehouseId,
            vars: {
              product_id: item.product_id,
              quantity: item.quantity_received ?? 0,
              grn_id: e.sourceDocId,
            },
            lotNumber: item.lot_number ?? null,
            expiryDate: null,
            manufactureDate: null,
            sourceDocType: 'goods_receipt_item',
            sourceDocId: e.sourceDocId,
            businessEventId: e.id,
          });
        }
      } catch {
        // shelf-edge labels are best-effort; the GRN itself is already posted.
      }
    });

    saga.register('delivery_note.dispatched', async (e: DomainEvent) => {
      await printLabel({
        orgId: e.orgId,
        templateKey: 'shipping_label',
        workflow: 'shipping',
        branchId: e.branchId,
        warehouseId: e.warehouseId,
        vars: { deliveryNoteId: e.sourceDocId, ...(e.payload as Record<string, unknown>) },
        sourceDocType: e.sourceDocType,
        sourceDocId: e.sourceDocId,
        businessEventId: e.id,
        idempotencyKey: `dn-shipping:${e.sourceDocId}`,
      });
    });

    saga.register('stock_transfer.dispatched', async (e: DomainEvent) => {
      await printLabel({
        orgId: e.orgId,
        templateKey: 'transfer_manifest',
        workflow: 'shipping',
        branchId: e.branchId,
        warehouseId: e.warehouseId,
        vars: { transferId: e.sourceDocId, ...(e.payload as Record<string, unknown>) },
        sourceDocType: e.sourceDocType,
        sourceDocId: e.sourceDocId,
        businessEventId: e.id,
        idempotencyKey: `st-manifest:${e.sourceDocId}`,
      });
    });

    saga.register('product.created', async (_e: DomainEvent) => {
      // Product creation does NOT auto-print — user opts in via the
      // inventory label-printer UI. Documented no-op.
    });

    saga.register('payment.received', async (e: DomainEvent) => {
      const payload = (e.payload ?? {}) as {
        method?: string;
        has_cash?: boolean;
        cash_total?: number;
        transaction_id?: string;
        transaction_number?: string;
      };

      // POS sales: the saga is the single owner of POS hardware
      // side-effects, and it owns them the same way every other module
      // does — by calling PrintService. The receipt is rendered, ledgered
      // and dispatched immediately on this host; there is no hardware
      // command queue and no worker in between.
      if (e.sourceDocType === 'pos_transaction' && e.sourceDocId) {
        const txId = e.sourceDocId;
        const hasCash = Boolean(payload.has_cash ?? (Number(payload.cash_total ?? 0) > 0));
        const businessId = (e as { businessId?: string | null }).businessId ?? null;
        if (hasCash) {
          const drawer = await toDevice({
            intentOrRole: 'cash_drawer',
            op: 'open',
            payload: { pin: 2, transaction_id: txId },
            organizationId: e.orgId ?? orgId ?? null,
            businessId,
            idempotencyKey: `pos-drawer:${txId}`,
            sourceDocType: 'pos_transaction',
            sourceDocId: txId,
            businessEventId: e.id,
          });
          if (!drawer.success) {
            console.warn('[saga payment.received] drawer not opened', drawer.error);
          }
        }
        const receipt = await printDocument({
          documentType: 'pos_receipt',
          documentId: txId,
          medium: 'escpos',
          organizationId: e.orgId ?? orgId ?? null,
          businessId,
          branchId: e.branchId ?? null,
          correlationId: `pos-receipt:${txId}`,
          businessEventId: e.id,
        });
        if (!receipt.success) {
          console.warn('[saga payment.received] receipt not printed', receipt.error);
        }
        return;
      }

      const method = (payload.method ?? '').toLowerCase();
      if (method !== 'cash') return;
      // Phase 5 Step B — non-POS cash receipts (manual cash, counter
      // takings) also resolve a `device_assignments` row before opening a
      // drawer. No role-only guess: if no drawer is bound for this org the
      // resolver refuses and the saga logs it.
      const drawer = await toDevice({
        intentOrRole: 'cash_drawer',
        op: 'open',
        payload: {},
        organizationId: e.orgId ?? orgId ?? null,
        businessId: (e as { businessId?: string | null }).businessId ?? null,
        idempotencyKey: `payment-drawer:${e.sourceDocId}`,
        sourceDocType: e.sourceDocType,
        sourceDocId: e.sourceDocId,
        businessEventId: e.id,
      });
      if (!drawer.success) {
        console.warn('[saga payment.received] drawer not opened', drawer.error);
      }
    });


    // Attendance — clock events ride the outbox. Payroll work entries are
    // generated batch-style per payroll run by `attendance_generate_work_entries`,
    // so the saga's job here is to (a) re-publish a derived
    // `attendance.shift_started/ended` event for UI surfaces (kiosk display,
    // supervisor toast) and (b) keep the door open for opt-in hardware
    // side-effects (door unlock, kiosk customer display).
    saga.register('attendance.clock_in', async (e: DomainEvent) => {
      await domainEventBus.publish({
        ...e,
        type: 'attendance.shift_started',
      });
    });
    saga.register('attendance.clock_out', async (e: DomainEvent) => {
      await domainEventBus.publish({
        ...e,
        type: 'attendance.shift_ended',
      });
    });

    // Stock Event Fabric (ADR 0076 · Inventory Foundation Wave Phase 6).
    // One emitter, one topic: `inventory.movement.recorded` is published by
    // `tg_stock_movement_emit_event` for EVERY stock_movements INSERT and is
    // routed server-scope, so the durable consumer is the `outbox-dispatcher`
    // edge function (reorder recompute). This host-side registration exists
    // only so a workstation can observe the fabric locally; it must never
    // recompute inventory truth in the browser.
    const stockMovementObserver = async (e: DomainEvent) => {
      const payload = (e.payload ?? {}) as {
        movement_class?: string;
        reference_type?: string;
      };
      console.debug(
        '[saga inventory.movement.recorded]',
        e.sourceDocId,
        payload.movement_class,
        payload.reference_type,
      );
    };
    saga.register('inventory.movement.recorded', stockMovementObserver);


    // Session 8 · Priority B — non-movement stock lifecycle consumers.
    // Placeholder handlers so the outbox → saga path is exercised end-to-end.
    // Feature modules can register additional listeners at any time.
    const stockLifecycleHandler = async (e: DomainEvent) => {
      console.debug('[saga stock.lifecycle]', e.type, e.sourceDocType, e.sourceDocId);
    };
    saga.register('stock.adjustment.posted', stockLifecycleHandler);
    saga.register('stock.transfer.approved', stockLifecycleHandler);
    saga.register('stock.transfer.completed', stockLifecycleHandler);
    saga.register('stock.count.completed', stockLifecycleHandler);
    saga.register('stock.count.cancelled', stockLifecycleHandler);

    // Warehouse (WMS) — log-only handlers so the outbox → saga path is
    // exercised end-to-end. Feature modules can register additional
    // consumers (label print, dock scheduling, replenishment) at any
    // time. See ADR 0079 and docs/architecture/WMS_MODULE_OWNERSHIP.md.
    //
    // Registration is driven off the canonical topic catalog so a new
    // topic can never be emitted without a subscriber wired up.
    const wmsHandler = async (e: DomainEvent) => {
      console.debug('[saga warehouse]', e.type, e.sourceDocType, e.sourceDocId);
    };
    for (const topic of Object.values(WMS_TOPIC)) {
      saga.register(topic, wmsHandler);
    }

    // Cross-dock subscriber (ADR 0079 · N8): whenever a receiving line
    // is captured, ask the DB to evaluate whether the freshly-received
    // stock matches an open sales-order line, and record a cross-dock
    // opportunity if so. The RPC is idempotent via a unique index on
    // (business_id, receiving_line_id) and emits
    // `warehouse.crossdock.matched` on success.
    saga.register(WMS_TOPIC.RECEIVING_LINE_CAPTURED, async (e: DomainEvent) => {
      const payload = (e.payload ?? {}) as { aggregate_id?: string; receiving_line_id?: string };
      const lineId = payload.aggregate_id ?? payload.receiving_line_id ?? e.sourceDocId;
      if (!lineId) return;
      try {
        await supabase.rpc('evaluate_crossdock_on_receiving_line' as never, {
          p_line_id: lineId,
        } as never);
      } catch (err) {
        console.warn('[saga crossdock] evaluate failed', err);
      }
    });



    saga.start();

    // Reclaim stale business-event leases on boot, then every 60s.
    void reclaimStaleBusinessEvents();
    const reclaimTimer = setInterval(() => {
      void reclaimStaleBusinessEvents();
    }, 60_000);

    // Recovery only. Normal prints never reach this sweeper — it exists
    // to re-dispatch ledger rows abandoned by a session that died
    // mid-print, and to bring offline workstations back into sync.
    const stopWorker = businessId ? startPrintRecoverySweeper(businessId) : () => {};

    return () => {
      saga.stop();
      clearInterval(reclaimTimer);
      stopWorker();
    };
  }, [orgId, branchId, businessId]);

  return null;
}

