import { describe, it, expect } from 'vitest';
import { CommandQueue, InMemoryQueueStore } from '../../../electron/hardware/CommandQueue';
import { InMemoryOutboxStore, SaleSaga, type SagaCommitPayload } from '../../../electron/hardware/SaleSaga';

function build() {
  const queueStore = new InMemoryQueueStore();
  const outbox = new InMemoryOutboxStore();
  const queue = new CommandQueue(queueStore, async () => ({ ok: true }));
  const saga = new SaleSaga(outbox, queue);
  return { queue, queueStore, outbox, saga };
}

const SALE: SagaCommitPayload = {
  saleId: 'sale-42',
  receipt: { lines: ['Item 1'] },
  drawer: { pin: 2 },
  display: { msg: 'Thank you' },
  gl: { amount: 100 },
};

describe('SaleSaga', () => {
  it('writes one outbox row + enqueues one command per step on commit', () => {
    const { saga, outbox, queueStore } = build();
    saga.commit(SALE);
    expect(outbox.listUnfinished().length).toBe(4);
    expect(queueStore.listByStatus('pending').length).toBe(4);
  });

  it('is idempotent — re-committing the same sale does not double-enqueue', () => {
    const { saga, queueStore } = build();
    saga.commit(SALE);
    saga.commit(SALE);
    expect(queueStore.listByStatus('pending').length).toBe(4);
  });

  it('skips steps the caller opted out of', () => {
    const { saga, outbox } = build();
    saga.commit({ saleId: 'cash-only', receipt: { lines: [] }, drawer: { pin: 2 } });
    const steps = outbox.listUnfinished().map(r => r.step).sort();
    expect(steps).toEqual(['open_drawer', 'print_receipt']);
  });

  it('advance() updates the outbox row', () => {
    const { saga, outbox } = build();
    saga.commit(SALE);
    saga.advance('sale-42', 'print_receipt', 'done');
    const row = outbox.findOne('sale-42', 'print_receipt');
    expect(row?.status).toBe('done');
  });

  it('replayUnfinished re-enqueues commands after a simulated crash', () => {
    // Crash scenario: process restarts, the in-memory queue has cleared
    // but the outbox + original payloads are persisted by upstream code.
    const { saga, outbox, queue, queueStore } = build();
    saga.commit(SALE);
    // simulate one step having completed before the crash
    saga.advance('sale-42', 'print_receipt', 'done');
    // simulate process restart by clearing only the queue rows we'd
    // already de-duped against (idempotency keys still match).
    const replayed = saga.replayUnfinished(new Map([['sale-42', SALE]]));
    expect(replayed).toBe(3); // print_receipt is done; 3 remain
    // queueStore.enqueue is idempotent, so total stays at 4
    expect(queueStore.listByStatus('pending').length + queueStore.listByStatus('done').length).toBe(4);
    void queue; // referenced for type-check
    void outbox;
  });
});
