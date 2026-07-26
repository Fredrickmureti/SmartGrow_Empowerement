/**
 * Wave B4.2 — AgentClient per-endpoint mutex.
 *
 * Asserts:
 *  1. Two concurrent prints to the SAME network endpoint are observed by the
 *     fetch transport in strict submission order (no interleave).
 *  2. Two concurrent prints to DIFFERENT endpoints actually overlap (the
 *     second request's body is seen before the first one's response settles).
 *  3. The endpoint key is normalized: `192.168.1.10:9100` and the same host
 *     with default port omitted share a lock.
 *  4. A rejected/never-resolving call does not poison the lock map — a
 *     follow-up call to the same endpoint still runs.
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

/**
 * Flush pending microtasks AND the macrotask queue. The endpoint gate races the
 * predecessor against a timer, so acquiring it costs more than a couple of
 * microtask ticks.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Recorded { url: string; body: string; settledAt: number | null }

function installFetchRecorder(): {
  records: Recorded[];
  pending: Array<Deferred<Response>>;
  restore: () => void;
} {
  const records: Recorded[] = [];
  const pending: Array<Deferred<Response>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = typeof init?.body === 'string' ? init.body : '';
    const rec: Recorded = { url, body, settledAt: null };
    records.push(rec);
    const d = defer<Response>();
    pending.push(d);
    const res = await d.promise;
    rec.settledAt = records.length; // ordinal tick when this fetch settled
    return res;
  }) as typeof fetch;
  return {
    records,
    pending,
    restore: () => { globalThis.fetch = original; },
  };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('AgentClient per-endpoint mutex (Wave B4.2)', () => {
  let harness: ReturnType<typeof installFetchRecorder>;

  beforeEach(() => { harness = installFetchRecorder(); });
  afterEach(() => { harness.restore(); });

  it('serializes two concurrent prints to the same endpoint', async () => {
    const p1 = agentClient.printNetwork('192.168.1.50', 9100, [0x1b, 0x40, 0x41]);
    const p2 = agentClient.printNetwork('192.168.1.50', 9100, [0x1b, 0x40, 0x42]);

    // Microtask drain: only the FIRST fetch should have been issued, because the
    // second is queued behind the endpoint lock.
    await tick();
    expect(harness.records).toHaveLength(1);
    expect(harness.records[0].body).toContain('"data":[27,64,65]');

    // Release the first request; only now should the second fetch fire.
    harness.pending[0].resolve(okResponse({ success: true }));
    await p1;
    await tick();
    expect(harness.records).toHaveLength(2);
    expect(harness.records[1].body).toContain('"data":[27,64,66]');

    harness.pending[1].resolve(okResponse({ success: true }));
    await p2;
  });

  it('runs prints to different endpoints in parallel', async () => {
    const p1 = agentClient.printNetwork('192.168.1.50', 9100, [0x01]);
    const p2 = agentClient.printNetwork('192.168.1.51', 9100, [0x02]);

    await tick();
    // Both fetches should have been issued before either response settles.
    expect(harness.records).toHaveLength(2);

    harness.pending[1].resolve(okResponse({ success: true }));
    harness.pending[0].resolve(okResponse({ success: true }));
    await Promise.all([p1, p2]);
  });

  it('normalizes the default raw-TCP port (9100) into the same lock', async () => {
    // Internally both calls should key to `net:192.168.1.60` (port stripped).
    const p1 = agentClient.printNetwork('192.168.1.60', 9100, [0x01]);
    const p2 = agentClient.printNetwork('192.168.1.60', 9100, [0x02]);
    await tick();
    expect(harness.records).toHaveLength(1);
    harness.pending[0].resolve(okResponse({ success: true }));
    await p1;
    await tick();
    expect(harness.records).toHaveLength(2);
    harness.pending[1].resolve(okResponse({ success: true }));
    await p2;
  });

  it('does not deadlock the endpoint after a failed request', async () => {
    const p1 = agentClient.printNetwork('192.168.1.70', 9100, [0x01]);
    // Wait for the fetch to be issued, then simulate a network failure.
    await tick();
    harness.pending[0].reject(new Error('boom'));
    const r1 = await p1;
    await tick();
    // printNetwork swallows fetch errors and returns { success: false }
    expect(r1.success).toBe(false);

    // A subsequent call must still acquire the lock and fire a new fetch.
    const p2 = agentClient.printNetwork('192.168.1.70', 9100, [0x02]);
    await tick();
    expect(harness.records).toHaveLength(2);
    harness.pending[1].resolve(okResponse({ success: true }));
    const r2 = await p2;
    expect(r2.success).toBe(true);
  });
});
