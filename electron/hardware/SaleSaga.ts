/**
 * SaleSaga — atomic sale-completion orchestration with crash recovery.
 *
 * On `sale:committed`, writes 4 outbox rows (print_receipt, open_drawer,
 * update_display, post_gl), enqueues the matching commands on
 * {@link CommandQueue}, and updates the outbox row when the queue
 * confirms terminal state. On app start, `replayUnfinished()` re-issues
 * commands for any outbox row whose step is still `pending` / `running` /
 * `failed`, restoring receipts lost to a mid-sale crash.
 *
 * Renderer code never touches this class directly — it fires
 * `pos:sale-committed` via `window.pos.sale.committed(payload)` and the
 * saga takes over.
 */

import type { CommandStatus, SagaStep } from './types';
import type { CommandQueue } from './CommandQueue';

export interface SagaCommitPayload {
  saleId: string;
  receipt?: unknown;
  drawer?: { pin?: 2 | 5 };
  display?: unknown;
  gl?: unknown;
}

export interface OutboxRow {
  id: number;
  sale_id: string;
  step: SagaStep;
  status: CommandStatus;
  attempts: number;
  last_error: string | null;
  created_at: number;
}

export interface OutboxStore {
  upsert(row: Omit<OutboxRow, 'id'>): OutboxRow;
  update(saleId: string, step: SagaStep, patch: Partial<OutboxRow>): void;
  listUnfinished(): OutboxRow[];
  findOne(saleId: string, step: SagaStep): OutboxRow | null;
}

/**
 * Durable storage for the original sale commit payload. Required for
 * crash-recovery: `replayUnfinished()` needs the receipt/drawer/display/gl
 * payloads to re-enqueue the saga steps; the in-memory map is lost on a
 * main-process crash. Implementations: `InMemoryPayloadStore` (tests),
 * `SqlitePayloadStore` (production, ADR-0014 Track H3b).
 */
export interface PayloadStore {
  put(saleId: string, payload: SagaCommitPayload): void;
  get(saleId: string): SagaCommitPayload | null;
  delete(saleId: string): void;
  all(): Map<string, SagaCommitPayload>;
}

const STEP_ORDER: SagaStep[] = ['print_receipt', 'open_drawer', 'update_display', 'post_gl'];

export const STEP_TO_ROLE_OP: Record<SagaStep, { role: 'receipt_printer' | 'cash_drawer' | 'customer_display' | 'saga'; op: string }> = {
  print_receipt: { role: 'receipt_printer', op: 'print_receipt' },
  open_drawer: { role: 'cash_drawer', op: 'open' },
  update_display: { role: 'customer_display', op: 'update' },
  // Track P (ADR-0014) — post_gl is saga housekeeping, not a payment
  // terminal vendor op. Routes through the synthetic 'saga' role; the
  // handler in `handlers/index.ts` ack's it and the renderer's
  // Supabase write performs the actual GL posting.
  post_gl: { role: 'saga', op: 'post_gl' },
};

/** Legacy outbox rows enqueued before Track P used `payment_terminal:post_gl`. */
export const LEGACY_POST_GL_KEY = 'payment_terminal:post_gl';

export class SaleSaga {
  // Wave 11 R5: terminalId starts NULL. `keyFor` refuses to run without
  // a real id so two terminals can never silently collide on the legacy
  // `"default":${saleId}:${step}` namespace.
  private terminalId: string | null = null;

  constructor(
    private store: OutboxStore,
    private queue: CommandQueue,
    private payloads: PayloadStore = new InMemoryPayloadStore(),
    private now: () => number = () => Date.now(),
  ) {}

  /**
   * Bind the active terminal so idempotency keys are scoped per terminal
   * (Audit Wave 9d.7 P4 + Wave 11 R5). Prevents two terminals colliding
   * on `${sale}:${step}` when they happen to process the same sale id.
   *
   * Passing `null` (or an empty string) un-binds and forces subsequent
   * commits to throw rather than silently key on `"default"`.
   */
  setTerminalId(id: string | null): void {
    this.terminalId = (id && typeof id === 'string' && id.trim().length > 0) ? id : null;
  }

  /** Swap the payload store (e.g. when SQLite becomes available post-login). */
  setPayloadStore(next: PayloadStore): void {
    // Drain in-memory rows into the durable store before swapping.
    for (const [saleId, payload] of this.payloads.all()) {
      try { next.put(saleId, payload); } catch { /* duplicate is fine */ }
    }
    this.payloads = next;
  }

  private keyFor(saleId: string, step: SagaStep): string {
    if (!this.terminalId) {
      // Loud failure beats silent idempotency collision across terminals.
      throw new Error(
        '[SaleSaga] terminalId is not set — refusing to enqueue. ' +
        'Ensure ElectronHydratorMount runs and pos:activeTerminalId is bound.'
      );
    }
    return `${this.terminalId}:${saleId}:${step}`;
  }




  /** Called on the `pos:sale-committed` IPC message. */
  commit(payload: SagaCommitPayload): void {
    const ts = this.now();
    // Persist the original payload FIRST so crash-recovery has the data
    // even if the outbox writes succeed but the process dies before any
    // step completes.
    try { this.payloads.put(payload.saleId, payload); } catch { /* idempotent put */ }
    for (const step of STEP_ORDER) {
      const stepPayload = this.payloadFor(step, payload);
      if (stepPayload === undefined) continue; // step opted-out for this sale
      this.store.upsert({
        sale_id: payload.saleId,
        step,
        status: 'pending',
        attempts: 0,
        last_error: null,
        created_at: ts,
      });
      const target = STEP_TO_ROLE_OP[step];
      this.queue.enqueue({
        role: target.role,
        op: target.op,
        payload: stepPayload,
        idempotencyKey: this.keyFor(payload.saleId, step),
      });
    }
  }

  /**
   * Mark a step as advanced based on the queue's terminal state. Called by
   * the queue worker via the EventBroker bridge in production; tests call
   * it directly.
   */
  advance(saleId: string, step: SagaStep, status: CommandStatus, error?: string): void {
    this.store.update(saleId, step, {
      status,
      last_error: error ?? null,
    });
  }

  /**
   * On app start, re-enqueue commands for any unfinished outbox rows.
   * Idempotency keys ensure we don't print twice if the queue already has
   * the row.
   *
   * Overload kept for backwards compatibility: callers may still pass a
   * `Map<saleId, payload>` directly (tests, in-memory scenarios). When
   * omitted, the saga's own `PayloadStore` is the source of truth.
   */
  replayUnfinished(originalPayloads?: Map<string, SagaCommitPayload>): number {
    const lookup: (saleId: string) => SagaCommitPayload | null = originalPayloads
      ? (s) => originalPayloads.get(s) ?? null
      : (s) => this.payloads.get(s);
    const unfinished = this.store.listUnfinished();
    let replayed = 0;
    for (const row of unfinished) {
      const payload = lookup(row.sale_id);
      if (!payload) continue; // payload lost — operator must intervene
      const stepPayload = this.payloadFor(row.step, payload);
      if (stepPayload === undefined) continue;
      const target = STEP_TO_ROLE_OP[row.step];
      this.queue.enqueue({
        role: target.role,
        op: target.op,
        payload: stepPayload,
        idempotencyKey: this.keyFor(row.sale_id, row.step),
      });
      replayed++;
    }
    return replayed;
  }

  private payloadFor(step: SagaStep, p: SagaCommitPayload): unknown | undefined {
    switch (step) {
      case 'print_receipt': return p.receipt;
      case 'open_drawer': return p.drawer ?? undefined;
      case 'update_display': return p.display;
      case 'post_gl': return p.gl;
    }
  }
}

export class InMemoryOutboxStore implements OutboxStore {
  private rows: OutboxRow[] = [];
  private seq = 0;

  upsert(row: Omit<OutboxRow, 'id'>): OutboxRow {
    const existing = this.rows.find(r => r.sale_id === row.sale_id && r.step === row.step);
    if (existing) return existing;
    const next: OutboxRow = { ...row, id: ++this.seq };
    this.rows.push(next);
    return next;
  }
  update(saleId: string, step: SagaStep, patch: Partial<OutboxRow>): void {
    const row = this.rows.find(r => r.sale_id === saleId && r.step === step);
    if (!row) return;
    Object.assign(row, patch);
  }
  listUnfinished(): OutboxRow[] {
    return this.rows.filter(r => r.status === 'pending' || r.status === 'running' || r.status === 'failed');
  }
  findOne(saleId: string, step: SagaStep): OutboxRow | null {
    return this.rows.find(r => r.sale_id === saleId && r.step === step) ?? null;
  }
}

export class InMemoryPayloadStore implements PayloadStore {
  private rows = new Map<string, SagaCommitPayload>();
  put(saleId: string, payload: SagaCommitPayload): void { this.rows.set(saleId, payload); }
  get(saleId: string): SagaCommitPayload | null { return this.rows.get(saleId) ?? null; }
  delete(saleId: string): void { this.rows.delete(saleId); }
  all(): Map<string, SagaCommitPayload> { return new Map(this.rows); }
}
