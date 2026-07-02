/**
 * CommandQueue — durable per-role FIFO with idempotency + retry budget.
 *
 * Backed by `hw_command_queue` in the encrypted SQLite (see schema.ts).
 * Abstracted over the DB driver so the queue can be unit-tested without
 * spinning up better-sqlite3.
 *
 * Semantics:
 *   - `enqueue(cmd)` is idempotent on `idempotencyKey`. Re-enqueuing the
 *     same key returns the existing row's eventual result.
 *   - The worker picks one row per role at a time (per-device FIFO).
 *   - Exponential backoff between attempts: 1s, 2s, 4s, 8s, 30s (capped
 *     by `maxAttempts`).
 *   - On exhaustion → status `dead` (operator must inspect / replay).
 */

import type { CommandStatus, DeviceRole, ExecCommand, ExecResult } from './types';

export interface QueueRow {
  id: number;
  device_role: DeviceRole;
  op: string;
  payload: string; // JSON
  status: CommandStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  idempotency_key: string;
  result: string | null; // JSON of ExecResult on success
  created_at: number;
  updated_at: number;
  /** Wave B1 Step 2.5 (C3) — epoch ms at which a failed row becomes
   *  eligible to be re-picked. NULL ⇒ immediately eligible. */
  next_attempt_at: number | null;
}

export interface QueueStore {
  findByKey(key: string): QueueRow | null;
  insert(row: Omit<QueueRow, 'id'>): QueueRow;
  update(id: number, patch: Partial<QueueRow>): void;
  /** Oldest pending row for the given role whose backoff window has elapsed. */
  nextPending(role: DeviceRole, now: number): QueueRow | null;
  /** All rows in a terminal state — used by tests + the dead-letter inspector. */
  listByStatus(status: CommandStatus, limit?: number): QueueRow[];
}

/** Default retry backoff in ms (1s, 2s, 4s, 8s, 30s). Index = attempt-1. */
export const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 30_000];


export class CommandQueue {
  private inflight = new Set<DeviceRole>();

  constructor(
    private store: QueueStore,
    private dispatch: (cmd: ExecCommand) => Promise<ExecResult>,
    private now: () => number = () => Date.now(),
  ) {}

  /**
   * Idempotent enqueue. Returns the row that represents this command — caller
   * can `await waitFor(row.id)` if they want the result, or fire-and-forget.
   */
  enqueue(cmd: ExecCommand): QueueRow {
    const existing = this.store.findByKey(cmd.idempotencyKey);
    if (existing) return existing;
    const ts = this.now();
    return this.store.insert({
      device_role: cmd.role,
      op: cmd.op,
      payload: JSON.stringify(cmd.payload ?? null),
      status: 'pending',
      attempts: 0,
      max_attempts: cmd.maxAttempts ?? 5,
      last_error: null,
      idempotency_key: cmd.idempotencyKey,
      result: null,
      created_at: ts,
      updated_at: ts,
      next_attempt_at: null,
    });
  }

  /**
   * Drive one tick of work for a given role. Returns the row touched, or
   * `null` if nothing was pending. Caller is responsible for the polling
   * loop / event-driven scheduling.
   *
   * Wave B1 Step 2.5 (C3): on failure, stamps `next_attempt_at = now +
   * backoffMs(attempts)` so the row is not re-picked until the backoff
   * window has elapsed. Fixes the hot-loop bug where `RETRY_BACKOFF_MS`
   * existed but was never consulted.
   */
  async tick(role: DeviceRole): Promise<QueueRow | null> {
    if (this.inflight.has(role)) return null;
    const tickNow = this.now();
    const row = this.store.nextPending(role, tickNow);
    if (!row) return null;

    this.inflight.add(role);
    try {
      this.store.update(row.id, { status: 'running', updated_at: this.now() });
      const cmd: ExecCommand = {
        role: row.device_role,
        op: row.op,
        payload: JSON.parse(row.payload),
        idempotencyKey: row.idempotency_key,
        maxAttempts: row.max_attempts,
      };
      const res = await this.dispatch(cmd);
      if (res.ok) {
        this.store.update(row.id, {
          status: 'done',
          attempts: row.attempts + 1,
          result: JSON.stringify(res),
          next_attempt_at: null,
          updated_at: this.now(),
        });
        return { ...row, status: 'done', attempts: row.attempts + 1, result: JSON.stringify(res), next_attempt_at: null };
      }
      const attempts = row.attempts + 1;
      const exhausted = attempts >= row.max_attempts;
      const nextAttemptAt = exhausted ? null : this.now() + this.backoffMs(attempts);
      this.store.update(row.id, {
        status: exhausted ? 'dead' : 'pending',
        attempts,
        last_error: res.error ?? 'unknown error',
        next_attempt_at: nextAttemptAt,
        updated_at: this.now(),
      });
      return { ...row, status: exhausted ? 'dead' : 'pending', attempts, last_error: res.error ?? null, next_attempt_at: nextAttemptAt };
    } catch (err) {
      const attempts = row.attempts + 1;
      const exhausted = attempts >= row.max_attempts;
      const nextAttemptAt = exhausted ? null : this.now() + this.backoffMs(attempts);
      this.store.update(row.id, {
        status: exhausted ? 'dead' : 'pending',
        attempts,
        last_error: (err as Error).message,
        next_attempt_at: nextAttemptAt,
        updated_at: this.now(),
      });
      return { ...row, status: exhausted ? 'dead' : 'pending', attempts, last_error: (err as Error).message, next_attempt_at: nextAttemptAt };
    } finally {
      this.inflight.delete(role);
    }
  }

  /** Backoff for the Nth attempt (1-indexed). attempt=1 → 1s, …, attempt>=5 → 30s. */
  backoffMs(attempt: number): number {
    const idx = Math.min(Math.max(attempt - 1, 0), RETRY_BACKOFF_MS.length - 1);
    return RETRY_BACKOFF_MS[idx];
  }


  // ──────────────────────────────────────────────────────────────────────
  // Wave 11 R2: dead-letter inspection + replay.
  //
  // Previously `status='dead'` rows were written to SQLite on retry
  // exhaustion but never surfaced anywhere — operators only discovered a
  // missed print when a customer complained. These three methods power
  // the new HardwareDiagnostics "Failed prints" card.
  // ──────────────────────────────────────────────────────────────────────

  /** All dead-letter rows, newest first (capped). */
  listDead(limit = 50): QueueRow[] {
    return this.store.listByStatus('dead', limit);
  }

  /**
   * Re-queue a dead row so the worker picks it up on the next tick.
   * Resets `attempts` to 0 and clears `last_error` so the retry budget
   * is honoured again.
   */
  replayDead(id: number): { ok: true } | { ok: false; error: string } {
    const rows = this.store.listByStatus('dead', 1000);
    const row = rows.find(r => r.id === id);
    if (!row) return { ok: false, error: `No dead row with id=${id}` };
    this.store.update(id, {
      status: 'pending',
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      updated_at: this.now(),
    });
    return { ok: true };
  }


  /**
   * Mark a dead row as `failed` so it is excluded from `listDead` but kept
   * for audit purposes. `failed` is a terminal status that never retries.
   */
  discardDead(id: number): { ok: true } | { ok: false; error: string } {
    const rows = this.store.listByStatus('dead', 1000);
    const row = rows.find(r => r.id === id);
    if (!row) return { ok: false, error: `No dead row with id=${id}` };
    this.store.update(id, {
      status: 'failed',
      updated_at: this.now(),
    });
    return { ok: true };
  }
}


/** In-memory implementation of {@link QueueStore} — used by tests + as the
 *  default before the SQLite store is wired up by `DatabaseManager`. */
export class InMemoryQueueStore implements QueueStore {
  private rows: QueueRow[] = [];
  private seq = 0;

  findByKey(key: string): QueueRow | null {
    return this.rows.find(r => r.idempotency_key === key) ?? null;
  }
  insert(row: Omit<QueueRow, 'id'>): QueueRow {
    const next: QueueRow = { ...row, id: ++this.seq };
    this.rows.push(next);
    return next;
  }
  update(id: number, patch: Partial<QueueRow>): void {
    const row = this.rows.find(r => r.id === id);
    if (!row) return;
    Object.assign(row, patch);
  }
  nextPending(role: DeviceRole, now: number = Date.now()): QueueRow | null {
    return this.rows
      .filter(r => r.device_role === role && r.status === 'pending' && (r.next_attempt_at == null || r.next_attempt_at <= now))
      .sort((a, b) => a.created_at - b.created_at)[0] ?? null;
  }

  listByStatus(status: CommandStatus, limit = 100): QueueRow[] {
    return this.rows.filter(r => r.status === status).slice(0, limit);
  }
}
