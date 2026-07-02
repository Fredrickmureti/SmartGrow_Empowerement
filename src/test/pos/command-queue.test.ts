import { describe, it, expect } from 'vitest';
import { CommandQueue, InMemoryQueueStore, RETRY_BACKOFF_MS } from '../../../electron/hardware/CommandQueue';
import type { ExecCommand, ExecResult } from '../../../electron/hardware/types';

function mkCmd(over: Partial<ExecCommand> = {}): ExecCommand {
  return {
    role: 'receipt_printer',
    op: 'print_receipt',
    payload: { lines: ['Hello'] },
    idempotencyKey: 'sale-1:print_receipt',
    maxAttempts: 3,
    ...over,
  };
}

describe('CommandQueue', () => {
  it('is idempotent on idempotencyKey', () => {
    const store = new InMemoryQueueStore();
    const q = new CommandQueue(store, async () => ({ ok: true }));
    const a = q.enqueue(mkCmd());
    const b = q.enqueue(mkCmd({ payload: { lines: ['Different!'] } }));
    expect(a.id).toBe(b.id);
    expect(JSON.parse(a.payload)).toEqual({ lines: ['Hello'] }); // first wins
  });

  it('drains a successful command on a single tick', async () => {
    const store = new InMemoryQueueStore();
    const dispatched: ExecCommand[] = [];
    const q = new CommandQueue(store, async (cmd) => { dispatched.push(cmd); return { ok: true, result: 42 }; });
    q.enqueue(mkCmd());
    const row = await q.tick('receipt_printer');
    expect(row?.status).toBe('done');
    expect(dispatched.length).toBe(1);
    expect(store.listByStatus('done').length).toBe(1);
  });

  it('moves to dead after exhausting the retry budget', async () => {
    const store = new InMemoryQueueStore();
    let clock = 1_000_000;
    const q = new CommandQueue(
      store,
      async (): Promise<ExecResult> => ({ ok: false, error: 'printer offline' }),
      () => clock,
    );
    q.enqueue(mkCmd({ maxAttempts: 2 }));
    const a = await q.tick('receipt_printer');
    expect(a?.status).toBe('pending'); // first failure → retry
    expect(a?.next_attempt_at).toBe(clock + 1_000); // attempt=1 → 1s backoff
    // Advance past the backoff window so the next tick can pick the row.
    clock += 5_000;
    const b = await q.tick('receipt_printer');
    expect(b?.status).toBe('dead');    // second failure → dead-letter
    expect(b?.last_error).toBe('printer offline');
    expect(b?.next_attempt_at).toBeNull(); // dead rows clear the schedule
  });

  it('isolates roles — work on one role does not block another', async () => {
    const store = new InMemoryQueueStore();
    const q = new CommandQueue(store, async () => ({ ok: true }));
    q.enqueue(mkCmd({ idempotencyKey: 'a', role: 'receipt_printer' }));
    q.enqueue(mkCmd({ idempotencyKey: 'b', role: 'cash_drawer', op: 'open' }));
    const [a, b] = await Promise.all([
      q.tick('receipt_printer'),
      q.tick('cash_drawer'),
    ]);
    expect(a?.status).toBe('done');
    expect(b?.status).toBe('done');
  });

  it('returns null when nothing is pending', async () => {
    const q = new CommandQueue(new InMemoryQueueStore(), async () => ({ ok: true }));
    expect(await q.tick('receipt_printer')).toBeNull();
  });

  it('exposes monotonic backoff', () => {
    const q = new CommandQueue(new InMemoryQueueStore(), async () => ({ ok: true }));
    for (let i = 0; i < RETRY_BACKOFF_MS.length - 1; i++) {
      expect(q.backoffMs(i + 1)).toBeLessThanOrEqual(q.backoffMs(i + 2));
    }
  });

  // ── Wave B1 Step 2.5 (C3) — backoff scheduling ─────────────────────
  it('does not re-pick a failed row until backoff has elapsed', async () => {
    const store = new InMemoryQueueStore();
    let clock = 5_000_000;
    const q = new CommandQueue(
      store,
      async (): Promise<ExecResult> => ({ ok: false, error: 'offline' }),
      () => clock,
    );
    q.enqueue(mkCmd({ maxAttempts: 5 }));

    const first = await q.tick('receipt_printer');
    expect(first?.status).toBe('pending');
    // attempt=1 → 1s backoff. nextPending must hide the row.
    expect(first?.next_attempt_at).toBe(clock + 1_000);

    // Tick again before backoff elapses → no row picked.
    clock += 500;
    expect(await q.tick('receipt_printer')).toBeNull();

    // Tick after backoff elapses → picked again.
    clock += 600;
    const second = await q.tick('receipt_printer');
    expect(second?.status).toBe('pending');
    expect(second?.attempts).toBe(2);
    expect(second?.next_attempt_at).toBe(clock + 2_000); // 2s backoff
  });

  it('clears next_attempt_at on successful completion', async () => {
    const store = new InMemoryQueueStore();
    let clock = 10_000_000;
    let firstCall = true;
    const q = new CommandQueue(
      store,
      async (): Promise<ExecResult> => {
        if (firstCall) { firstCall = false; return { ok: false, error: 'oops' }; }
        return { ok: true };
      },
      () => clock,
    );
    q.enqueue(mkCmd());
    await q.tick('receipt_printer'); // fails → backoff stamped
    clock += 2_000;
    const ok = await q.tick('receipt_printer');
    expect(ok?.status).toBe('done');
    expect(ok?.next_attempt_at).toBeNull();
  });
});

