/**
 * Track H4b — crash-recovery contract for SaleSaga + PayloadStore.
 *
 * Models the exact production sequence ADR-0014 Track H3b promises to
 * survive: the renderer fires `pos:sale-committed`, the saga writes the
 * outbox rows and persists the original payload, the queue starts
 * draining, the process dies BEFORE every step reaches `done`, and on
 * restart `replayUnfinished()` re-enqueues only the unfinished steps —
 * pulling the original payload from the durable store, not from the
 * in-memory map that the previous process took to its grave.
 *
 * The test uses {@link InMemoryPayloadStore} as a stand-in for
 * `SqlitePayloadStore` because (a) both implement the same
 * `PayloadStore` interface, (b) the SQLite native binding cannot load
 * inside the jsdom Vitest pool, and (c) the failure mode we care about
 * is the saga losing its in-memory payload Map — which is independent
 * of the storage backend.
 */

import { describe, it, expect, vi } from 'vitest';
import { CommandQueue, InMemoryQueueStore } from '../../../electron/hardware/CommandQueue';
import {
  InMemoryOutboxStore,
  InMemoryPayloadStore,
  SaleSaga,
  type SagaCommitPayload,
} from '../../../electron/hardware/SaleSaga';
import type { ExecCommand, ExecResult } from '../../../electron/hardware/types';

const SALE: SagaCommitPayload = {
  saleId: 'sale-crash-1',
  receipt: { lines: ['Item A', 'Item B'] },
  drawer: { pin: 2 },
  display: { msg: 'Thank you' },
  gl: { amount: 250 },
};

function build(dispatch: (cmd: ExecCommand) => Promise<ExecResult>) {
  const outbox = new InMemoryOutboxStore();
  const payloads = new InMemoryPayloadStore();
  const queueStore = new InMemoryQueueStore();
  const queue = new CommandQueue(queueStore, dispatch);
  const saga = new SaleSaga(outbox, queue, payloads);
  return { outbox, payloads, queueStore, queue, saga };
}

describe('SaleSaga crash recovery (Track H3b / H4b)', () => {
  it('persists the original commit payload to the PayloadStore on commit', () => {
    const dispatch = vi.fn(async () => ({ ok: true }) as ExecResult);
    const { saga, payloads } = build(dispatch);
    saga.commit(SALE);
    const stored = payloads.get(SALE.saleId);
    expect(stored).not.toBeNull();
    expect(stored?.saleId).toBe(SALE.saleId);
    expect((stored?.gl as { amount: number }).amount).toBe(250);
  });

  it('replayUnfinished() rebuilds queue from the PayloadStore after a "process restart"', async () => {
    // === Process 1: commit + drain one step ===
    const dispatch1 = vi.fn(async () => ({ ok: true }) as ExecResult);
    const { saga: saga1, outbox, payloads, queueStore } = build(dispatch1);
    saga1.commit(SALE);
    // Mark print_receipt as done — the remaining 3 must be re-enqueued.
    saga1.advance(SALE.saleId, 'print_receipt', 'done');
    expect(outbox.findOne(SALE.saleId, 'print_receipt')?.status).toBe('done');

    // === Simulate crash: NEW SaleSaga instance (lost in-memory Map),
    // but the OutboxStore + PayloadStore are durable, so we re-attach
    // them to a brand-new saga that knows nothing about SALE. The new
    // queue is also empty (mid-flight enqueues were lost).
    const dispatch2 = vi.fn(async () => ({ ok: true }) as ExecResult);
    const newQueueStore = new InMemoryQueueStore();
    const newQueue = new CommandQueue(newQueueStore, dispatch2);
    const saga2 = new SaleSaga(outbox, newQueue, payloads);

    // === Process 2: replay with NO override map (must use PayloadStore) ===
    const replayed = saga2.replayUnfinished();

    // print_receipt was 'done' → skipped. 3 unfinished steps remain.
    expect(replayed).toBe(3);
    const pending = newQueueStore.listByStatus('pending');
    expect(pending.length).toBe(3);
    const steps = pending.map((r) => r.op).sort();
    expect(steps).toEqual(['open', 'post_gl', 'update'].sort());

    // Idempotency keys must match `<saleId>:<step>` so the queue de-dupes
    // if a half-enqueued command was already persisted by the dead process.
    for (const row of pending) {
      expect(row.idempotency_key.startsWith(SALE.saleId)).toBe(true);
    }

    // Queue rows should NOT include the already-completed step.
    expect(pending.find((r) => r.op === 'print_receipt')).toBeUndefined();

    // Original payloads (queueStore from process 1) were intentionally
    // left untouched to mirror "the queue is volatile" semantics.
    void queueStore; void dispatch1;
  });

  it('skips replay for sales whose payload is missing (operator-recoverable)', () => {
    // Replicate the scenario where the OutboxStore survived but the
    // PayloadStore was wiped (e.g. db migration removed the row). The
    // saga must not crash and must not re-enqueue with a synthetic
    // payload — the operator needs to know.
    const dispatch = vi.fn(async () => ({ ok: true }) as ExecResult);
    const { saga, outbox, queueStore, payloads } = build(dispatch);
    saga.commit(SALE);
    payloads.delete(SALE.saleId);

    // Build a fresh saga sharing the same now-empty payload store.
    const saga2 = new SaleSaga(outbox, new CommandQueue(new InMemoryQueueStore(), dispatch), payloads);
    const replayed = saga2.replayUnfinished();
    expect(replayed).toBe(0);

    // The original queue still has its rows — but no new enqueues happened.
    void queueStore;
  });

  it('setPayloadStore migrates pre-login in-memory payloads into the new store', () => {
    const dispatch = vi.fn(async () => ({ ok: true }) as ExecResult);
    const { saga } = build(dispatch);
    saga.commit(SALE);

    // Swap in a fresh durable store mid-process (the production hook
    // that runs right after `database:initialize` succeeds).
    const durable = new InMemoryPayloadStore();
    saga.setPayloadStore(durable);

    const carried = durable.get(SALE.saleId);
    expect(carried).not.toBeNull();
    expect(carried?.saleId).toBe(SALE.saleId);
  });
});
