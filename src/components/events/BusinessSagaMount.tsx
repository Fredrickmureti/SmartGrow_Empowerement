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
import { printClient } from '@/services/printing/PrintClient';
import { execForIntent } from '@/services/hardware/execForIntent';
import { domainEventBus, type DomainEvent } from '@/services/events/domainEventBus';
import { customerDisplayClient, type CustomerDisplayData } from '@/services/hardware/local-display/CustomerDisplayClient';
import {
  startSharedCommandQueueWorker,
  reclaimStaleBusinessEvents,
} from '@/services/hardware/SharedCommandQueueWorker';
import { useBranches } from '@/hooks/useBranches';



interface Props {
  orgId: string | null | undefined;
}

export function BusinessSagaMount({ orgId }: Props) {
  const { currentBranch } = useBranches();
  const branchId = currentBranch?.id ?? null;

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
      await printClient.printLabel({
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
          await printClient.printLabel({
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
      await printClient.printLabel({
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
      await printClient.printLabel({
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

      // POS sales (Group D #6): the saga is the single owner of POS
      // hardware side-effects. Enqueue onto `hardware_command_queue`
      // so the shared worker on whichever host has the drawer / receipt
      // printer attached drains the row. Idempotency keys mirror the
      // browser-mode shape so any in-flight rows during the transition
      // window are deduped at the (org_id, idempotency_key) unique index.
      if (e.sourceDocType === 'pos_transaction' && e.sourceDocId) {
        const txId = e.sourceDocId;
        const hasCash = Boolean(payload.has_cash ?? (Number(payload.cash_total ?? 0) > 0));
        const supabase = (await import('@/integrations/supabase/client')).supabase;
        try {
          if (hasCash) {
            await supabase.rpc('enqueue_hardware_command', {
              p_org_id: e.orgId,
              p_branch_id: e.branchId ?? null,
              p_device_assignment_id: null,
              p_role: 'cash_drawer',
              p_op: 'open',
              p_payload: { pin: 2, transaction_id: txId },
              p_idempotency_key: `pos-drawer:${txId}`,
              p_business_event_id: e.id ?? null,
              p_source_doc_type: 'pos_transaction',
              p_source_doc_id: txId,
            });
          }
          const { generateDocumentEscPosBytes } = await import('@/services/printing/pdfUtils');
          const receiptBytes = await generateDocumentEscPosBytes('pos_receipt', txId);
          await supabase.rpc('enqueue_hardware_command', {
            p_org_id: e.orgId,
            p_branch_id: e.branchId ?? null,
            p_device_assignment_id: null,
            p_role: 'receipt_printer',
            p_op: 'print_raw',
            p_payload: Array.from(receiptBytes),
            p_idempotency_key: `pos-receipt:${txId}`,
            p_business_event_id: e.id ?? null,
            p_source_doc_type: 'pos_transaction',
            p_source_doc_id: txId,
          });
        } catch (err) {
          console.warn('[saga payment.received] enqueue failed', err);
        }
        return;
      }

      const method = (payload.method ?? '').toLowerCase();
      if (method !== 'cash') return;
      // Phase 5 Step B — non-POS cash receipts (manual cash, counter
      // takings) also resolve a `device_assignments` row before opening a
      // drawer. No role-only guess: if no drawer is bound for this org the
      // resolver refuses and the saga logs it.
      const drawer = await execForIntent({
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

    // Stock Event Fabric (ADR 0076) — proof-of-fabric consumer.
    // The DB trigger `trg_check_warehouse_stock_alerts` currently ALSO
    // recomputes low-stock alerts synchronously from stock_movements.
    // This saga handler subscribes to the outbox path for the same
    // movement so we can observe both paths in production and cut over
    // by dropping the DB trigger once the saga path proves durable.
    // Dual-write is intentional; the handler is idempotent (the RPC
    // key on stock_movements.id).
    const stockAlertHandler = async (e: DomainEvent) => {
      const payload = (e.payload ?? {}) as { reference_type?: string };
      // The trigger already handles the sync path; the saga path exists
      // as a checkpoint that the outbox → handler pipeline is alive.
      // Real replenishment recompute lands here once the trigger is dropped.
      console.debug('[saga stock.movement]', e.type, e.sourceDocId, payload.reference_type);
    };
    saga.register('stock.movement.received', stockAlertHandler);
    saga.register('stock.movement.dispatched', stockAlertHandler);
    saga.register('stock.movement.adjusted', stockAlertHandler);
    saga.register('stock.movement.transferred', stockAlertHandler);
    saga.register('stock.movement.posted', stockAlertHandler);

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
    // time. See ADR 0079 for the Inventory/Warehouse split.
    const wmsHandler = async (e: DomainEvent) => {
      console.debug('[saga warehouse]', e.type, e.sourceDocType, e.sourceDocId);
    };
    saga.register('warehouse.task.assigned', wmsHandler);
    saga.register('warehouse.task.started', wmsHandler);
    saga.register('warehouse.task.completed', wmsHandler);
    saga.register('warehouse.task.cancelled', wmsHandler);
    saga.register('warehouse.plate.moved', wmsHandler);
    saga.register('warehouse.plate.sealed', wmsHandler);
    saga.register('warehouse.receipt.staged', wmsHandler);
    saga.register('warehouse.putaway.suggested', wmsHandler);
    saga.register('warehouse.putaway.completed', wmsHandler);
    saga.register('warehouse.wave.released', wmsHandler);
    saga.register('warehouse.pick.completed', wmsHandler);
    saga.register('warehouse.pack.completed', wmsHandler);
    saga.register('warehouse.carton.opened', wmsHandler);
    saga.register('warehouse.carton.sealed', wmsHandler);
    saga.register('warehouse.count.opened', wmsHandler);
    saga.register('warehouse.count.recorded', wmsHandler);
    saga.register('warehouse.count.posted', wmsHandler);
    saga.register('warehouse.manifest.opened', wmsHandler);
    saga.register('warehouse.manifest.closed', wmsHandler);
    saga.register('warehouse.manifest.dispatched', wmsHandler);
    saga.register('warehouse.carton.shipped', wmsHandler);

    // Phase 6 — Dock scheduling & appointments.
    saga.register('warehouse.appointment.scheduled', wmsHandler);
    saga.register('warehouse.appointment.arrived', wmsHandler);
    saga.register('warehouse.appointment.in_progress', wmsHandler);
    saga.register('warehouse.appointment.completed', wmsHandler);
    saga.register('warehouse.appointment.cancelled', wmsHandler);

    // Phase 7 — QC inspection lifecycle.
    saga.register('warehouse.qc.opened', wmsHandler);
    saga.register('warehouse.qc.accepted', wmsHandler);
    saga.register('warehouse.qc.rejected', wmsHandler);
    saga.register('warehouse.qc.cancelled', wmsHandler);

    saga.start();

    // Reclaim stale business-event leases on boot, then every 60s.
    void reclaimStaleBusinessEvents();
    const reclaimTimer = setInterval(() => {
      void reclaimStaleBusinessEvents();
    }, 60_000);

    // Start the shared hardware command-queue worker so cross-host
    // print/drawer jobs queued via enqueue_hardware_command actually run.
    const stopWorker = startSharedCommandQueueWorker(orgId, branchId);

    return () => {
      saga.stop();
      clearInterval(reclaimTimer);
      stopWorker();
    };
  }, [orgId, branchId]);

  return null;
}

