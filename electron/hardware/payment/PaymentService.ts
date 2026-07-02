/**
 * PaymentService — owns the {@link PaymentStateMachine} per transaction,
 * dispatches to the active {@link IPaymentTerminalDriver}, and writes
 * every transition to `pos_payment_terminal_log` for crash recovery and
 * settlement reconciliation.
 *
 * Idempotency is enforced TWICE:
 *   1. By `idempotency_key` UNIQUE in `pos_payment_terminal_log` — a
 *      repeat `charge()` returns the cached row's terminal result.
 *   2. By the vendor driver itself (mock + every real vendor we plan to
 *      integrate ships its own idempotency story).
 *
 * The DB getter is injected so this works equally in main with
 * `better-sqlite3` and in tests with an in-memory shim.
 */

import { PaymentStateMachine, type TransitionEvent } from './PaymentStateMachine';
import type {
  AuthResult, ChargeRequest, IPaymentTerminalDriver, TxnState,
} from './IPaymentTerminalDriver';
import type { EventBroker } from '../EventBroker';

export interface PaymentLogRow {
  id?: number;
  txn_id: string;
  pos_order_id: string | null;
  vendor: string;
  state: TxnState;
  amount_cents: number;
  currency: string;
  auth_id: string | null;
  vendor_txn_id: string | null;
  idempotency_key: string;
  error: string | null;
  auto_capture: number;
  created_at: number;
  updated_at: number;
}

/** Pluggable persistence — SQLite-backed in main, in-memory in tests. */
export interface PaymentLogStore {
  findByIdempotency(key: string): PaymentLogRow | null;
  insert(row: Omit<PaymentLogRow, 'id'>): PaymentLogRow;
  update(id: number, patch: Partial<PaymentLogRow>): void;
  listApprovedOlderThan(cutoffMs: number): PaymentLogRow[];
  findByAuthId(authId: string): PaymentLogRow | null;
}

export interface PaymentServiceOptions {
  driver: IPaymentTerminalDriver;
  store: PaymentLogStore;
  broker?: Pick<EventBroker, 'publish'>;
  now?: () => number;
  /** Default 1 → auto-capture during EOD settlement. */
  autoCapture?: boolean;
}

export class PaymentService {
  private readonly opts: Required<Omit<PaymentServiceOptions, 'broker'>> & {
    broker?: PaymentServiceOptions['broker'];
  };

  constructor(opts: PaymentServiceOptions) {
    this.opts = {
      driver: opts.driver,
      store: opts.store,
      broker: opts.broker,
      now: opts.now ?? (() => Date.now()),
      autoCapture: opts.autoCapture ?? true,
    };
  }

  get vendor(): string { return this.opts.driver.vendor; }

  swapDriver(driver: IPaymentTerminalDriver): void {
    (this.opts as { driver: IPaymentTerminalDriver }).driver = driver;
  }

  async charge(req: ChargeRequest & { posOrderId?: string }): Promise<AuthResult> {
    const existing = this.opts.store.findByIdempotency(req.idempotencyKey);
    if (existing) {
      // Return cached terminal result if we already settled this key.
      return {
        ok: existing.state === 'approved' || existing.state === 'captured' || existing.state === 'settled',
        state: existing.state,
        authId: existing.auth_id ?? undefined,
        vendorTxnId: existing.vendor_txn_id ?? undefined,
        amountCents: existing.amount_cents,
        currency: existing.currency,
        reason: existing.error ?? undefined,
      };
    }
    const fsm = new PaymentStateMachine(req.idempotencyKey);
    this.attachBroker(fsm);
    const ts = this.opts.now();

    fsm.transition('collecting', 'card present');
    fsm.transition('authorizing', 'sending to vendor');

    let result: AuthResult;
    try {
      result = await this.opts.driver.charge(req);
    } catch (err) {
      result = { ok: false, state: 'error', reason: (err as Error).message };
    }

    try { fsm.transition(result.state, result.reason); }
    catch { /* driver returned unreachable state; force error */
      try { fsm.transition('error', `unreachable state ${result.state}`); } catch { /* already terminal */ }
      result = { ok: false, state: 'error', reason: `vendor returned unreachable state ${result.state}` };
    }

    const row: Omit<PaymentLogRow, 'id'> = {
      txn_id: req.idempotencyKey,
      pos_order_id: req.posOrderId ?? req.metadata?.posOrderId ?? null,
      vendor: this.opts.driver.vendor,
      state: fsm.state,
      amount_cents: result.amountCents ?? req.amountCents,
      currency: result.currency ?? req.currency,
      auth_id: result.authId ?? null,
      vendor_txn_id: result.vendorTxnId ?? null,
      idempotency_key: req.idempotencyKey,
      error: result.reason ?? null,
      auto_capture: this.opts.autoCapture ? 1 : 0,
      created_at: ts,
      updated_at: this.opts.now(),
    };
    this.opts.store.insert(row);
    return result;
  }

  async capture(authId: string): Promise<AuthResult> {
    const row = this.opts.store.findByAuthId(authId);
    if (!row) return { ok: false, state: 'error', reason: 'auth not found' };
    if (row.state === 'captured' || row.state === 'settled') {
      return { ok: true, state: row.state, authId };
    }
    if (row.state !== 'approved') {
      return { ok: false, state: 'error', reason: `cannot capture from ${row.state}` };
    }
    const r = await this.opts.driver.capture(authId);
    this.opts.store.update(row.id!, {
      state: r.ok ? 'captured' : 'error',
      error: r.reason ?? null,
      updated_at: this.opts.now(),
    });
    this.publish({ txnId: row.txn_id, from: row.state, to: r.ok ? 'captured' : 'error', ts: this.opts.now(), reason: r.reason });
    return r;
  }

  async voidAuth(authId: string): Promise<AuthResult> {
    const row = this.opts.store.findByAuthId(authId);
    if (!row) return { ok: false, state: 'error', reason: 'auth not found' };
    if (row.state !== 'approved') {
      return { ok: false, state: 'error', reason: `cannot void from ${row.state}` };
    }
    const r = await this.opts.driver.voidAuth(authId);
    this.opts.store.update(row.id!, {
      state: r.ok ? 'voided' : 'error',
      error: r.reason ?? null,
      updated_at: this.opts.now(),
    });
    return r;
  }

  async refund(authId: string, amountCents: number): Promise<AuthResult> {
    const row = this.opts.store.findByAuthId(authId);
    if (!row) return { ok: false, state: 'error', reason: 'auth not found' };
    if (row.state !== 'settled' && row.state !== 'captured') {
      return { ok: false, state: 'error', reason: `cannot refund from ${row.state}` };
    }
    const r = await this.opts.driver.refund(authId, amountCents);
    this.opts.store.update(row.id!, {
      state: r.ok ? 'refunded' : 'error',
      error: r.reason ?? null,
      updated_at: this.opts.now(),
    });
    return r;
  }

  async cancelInFlight(): Promise<void> {
    await this.opts.driver.cancelInFlight();
  }

  async getStatus(): Promise<{ ready: boolean; reason?: string }> {
    return this.opts.driver.getStatus();
  }

  private attachBroker(fsm: PaymentStateMachine): void {
    if (!this.opts.broker) return;
    fsm.on((e) => this.publish(e));
  }

  private publish(e: TransitionEvent): void {
    if (!this.opts.broker) return;
    try {
      this.opts.broker.publish({
        type: 'payment_terminal:state',
        role: 'payment_terminal',
        ts: e.ts,
        data: { txnId: e.txnId, from: e.from, to: e.to, reason: e.reason, vendor: this.opts.driver.vendor },
      });
    } catch { /* swallow */ }
  }
}

// ── In-memory store (tests + pre-DB-init main) ───────────────────────────

export class InMemoryPaymentLogStore implements PaymentLogStore {
  private rows: PaymentLogRow[] = [];
  private seq = 0;

  findByIdempotency(key: string): PaymentLogRow | null {
    return this.rows.find(r => r.idempotency_key === key) ?? null;
  }
  insert(row: Omit<PaymentLogRow, 'id'>): PaymentLogRow {
    const next: PaymentLogRow = { ...row, id: ++this.seq };
    this.rows.push(next);
    return next;
  }
  update(id: number, patch: Partial<PaymentLogRow>): void {
    const row = this.rows.find(r => r.id === id);
    if (row) Object.assign(row, patch);
  }
  listApprovedOlderThan(cutoffMs: number): PaymentLogRow[] {
    return this.rows.filter(r => r.state === 'approved' && r.auto_capture === 1 && r.updated_at <= cutoffMs);
  }
  findByAuthId(authId: string): PaymentLogRow | null {
    return this.rows.find(r => r.auth_id === authId) ?? null;
  }
  _all(): PaymentLogRow[] { return [...this.rows]; }
}