/**
 * Plan Phase G3 — FIFO parity between the two print transports.
 *
 * The PDF/iframe branch is locked in by `print-pdf-fifo-queue.test.ts`.
 * This sibling asserts the same shape for the raw-bytes (thermal)
 * branch: five concurrent `printNetwork` calls to the same endpoint
 * MUST execute strictly one-at-a-time, in submission order, with a
 * failing job not poisoning the chain and no coalescing / dropping.
 *
 * Load-bearing invariant: `AgentClient._withEndpointLock` +
 * `agent/src/routes/print.ts` FIFO. Both pipelines are now pinned to
 * identical semantics, so the Sales-vs-Labels asymmetry that motivated
 * the whole print-pipeline rewrite cannot silently regress on either
 * side.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { agentClient } from '@/services/hardware/local-agent/AgentClient';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// One macrotask + microtask drain — the endpoint gate races the
// predecessor against a timer, so it costs more than a couple of ticks.
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

interface Recorded { url: string; body: string }

function installFetchRecorder() {
  const records: Recorded[] = [];
  const pending: Array<Deferred<Response>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = typeof init?.body === 'string' ? init.body : '';
    records.push({ url, body });
    const d = defer<Response>();
    pending.push(d);
    return d.promise;
  }) as typeof fetch;
  return { records, pending, restore: () => { globalThis.fetch = original; } };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('thermal/raw-bytes FIFO parity with PDF branch (Plan G3)', () => {
  let harness: ReturnType<typeof installFetchRecorder>;

  beforeEach(() => { harness = installFetchRecorder(); });
  afterEach(() => { harness.restore(); });

  it('serializes 5 concurrent prints to the same endpoint: exactly one fetch in flight at a time, submission order preserved', async () => {
    const payloads = [
      [0x1b, 0x40, 0x01],
      [0x1b, 0x40, 0x02],
      [0x1b, 0x40, 0x03],
      [0x1b, 0x40, 0x04],
      [0x1b, 0x40, 0x05],
    ];
    const promises = payloads.map((p) => agentClient.printNetwork('192.168.1.80', 9100, p));

    // Drain: only the FIRST fetch should have been issued.
    await tick();
    expect(harness.records).toHaveLength(1);
    expect(harness.records[0].body).toContain('"data":[27,64,1]');

    // Complete jobs one by one. Each completion MUST advance the queue
    // to the next fetch — never skip, never coalesce, never reorder.
    for (let i = 0; i < payloads.length; i++) {
      harness.pending[i].resolve(okResponse({ success: true }));
      await promises[i];
      await tick();
      const expectedCount = Math.min(i + 2, payloads.length);
      expect(harness.records).toHaveLength(expectedCount);
      if (i + 1 < payloads.length) {
        expect(harness.records[i + 1].body).toContain(
          `"data":[27,64,${payloads[i + 1][2]}]`,
        );
      }
    }

    // All 5 jobs ran to completion in strict order.
    expect(harness.records).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(harness.records[i].body).toContain(`"data":[27,64,${i + 1}]`);
    }
  });

  it('a failing job does not poison the queue for subsequent jobs (5 concurrent, middle one fails)', async () => {
    const p1 = agentClient.printNetwork('192.168.1.81', 9100, [0xAA, 0x01]);
    const p2 = agentClient.printNetwork('192.168.1.81', 9100, [0xAA, 0x02]);
    const p3 = agentClient.printNetwork('192.168.1.81', 9100, [0xAA, 0x03]);
    const p4 = agentClient.printNetwork('192.168.1.81', 9100, [0xAA, 0x04]);
    const p5 = agentClient.printNetwork('192.168.1.81', 9100, [0xAA, 0x05]);

    await tick();
    expect(harness.records).toHaveLength(1);
    // Job 1 succeeds.
    harness.pending[0].resolve(okResponse({ success: true }));
    await p1;
    await tick();

    // Job 2 fails at the transport layer.
    expect(harness.records).toHaveLength(2);
    harness.pending[1].reject(new Error('mock transport blew up'));
    const r2 = await p2;
    expect(r2.success).toBe(false);
    await tick();

    // Jobs 3, 4, 5 must still run in order — the lock chain is not poisoned.
    expect(harness.records).toHaveLength(3);
    harness.pending[2].resolve(okResponse({ success: true }));
    await p3;
    await tick();

    expect(harness.records).toHaveLength(4);
    harness.pending[3].resolve(okResponse({ success: true }));
    await p4;
    await tick();

    expect(harness.records).toHaveLength(5);
    harness.pending[4].resolve(okResponse({ success: true }));
    const r5 = await p5;
    expect(r5.success).toBe(true);
    expect(harness.records[4].body).toContain('"data":[170,5]');
  });
});
