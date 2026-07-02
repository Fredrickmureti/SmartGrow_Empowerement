/**
 * BusinessSaga — drains `business_event_outbox` and dispatches each
 * event to its registered hardware / notification / print handlers.
 *
 * Sibling of the POS `SaleSaga` (electron/hardware/SaleSaga.ts) but
 * scoped to non-POS domain events. Uses the database's
 * `claim_next_business_event` RPC, which atomically marks the row
 * `running` under `FOR UPDATE SKIP LOCKED`, so multiple hosts in the
 * same org cannot double-process.
 *
 * Failure model:
 *   - Handler throws → `complete_business_event(id, false, err)` →
 *     row stays available for retry (up to 10 attempts via the RPC).
 *   - Handler returns → `complete_business_event(id, true)`.
 *
 * This worker is meant to run **once per host**, mounted via
 * <BusinessSagaMount /> at the app root for the active org.
 */

import { supabase } from '@/integrations/supabase/client';
import { domainEventBus, type DomainEvent, type DomainEventType } from './domainEventBus';

export type SagaHandler = (event: DomainEvent) => Promise<void> | void;

interface OutboxRow {
  id: string;
  org_id: string;
  branch_id: string | null;
  warehouse_id: string | null;
  event_type: string;
  source_doc_type: string;
  source_doc_id: string;
  payload: unknown;
  created_at: string;
}

export class BusinessSaga {
  private handlers = new Map<DomainEventType, SagaHandler[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(
    private orgId: string,
    private intervalMs = 4000,
    private branchId: string | null = null,
  ) {}

  register(type: DomainEventType, handler: SagaHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const { data, error } = await supabase.rpc('claim_next_business_event', {
        p_org_id: this.orgId,
        p_limit: 5,
        p_branch_id: this.branchId,
      });
      if (error || !data) return;
      for (const row of data as OutboxRow[]) {
        await this.process(row);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async process(row: OutboxRow): Promise<void> {
    const event: DomainEvent = {
      id: row.id,
      type: row.event_type as DomainEventType,
      orgId: row.org_id,
      branchId: row.branch_id,
      warehouseId: row.warehouse_id,
      sourceDocType: row.source_doc_type,
      sourceDocId: row.source_doc_id,
      payload: row.payload,
      occurredAt: row.created_at,
    };

    try {
      // Fan out to in-process subscribers (UI reactions, optimistic
      // updates) AND saga-registered handlers (the durable ones).
      await domainEventBus.publish(event);
      const list = this.handlers.get(event.type) ?? [];
      for (const h of list) await h(event);
      await supabase.rpc('complete_business_event', {
        p_id: row.id,
        p_success: true,
        p_error: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabase.rpc('complete_business_event', {
        p_id: row.id,
        p_success: false,
        p_error: msg,
      });
    }
  }
}
