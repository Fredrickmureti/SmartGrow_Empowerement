/**
 * Track H7a — DeviceManager liveness loop + circuit breaker.
 *
 * The pre-H7a health loop only emitted `device:heartbeat` regardless of
 * whether the underlying transport was reachable. A printer unplugged
 * for 10 minutes still showed green in the device card. This test pins
 * the new behavior:
 *
 *   • Real `ping` per active assignment, parallel across devices.
 *   • State machine: connected → degraded after N consecutive failures
 *     → connected on first success (with `recovered: true` event).
 *   • Degraded devices back off to the longer probe interval so a dead
 *     device cannot saturate the loop.
 *   • Status snapshot via `getStatuses()` carries `state`, `lastError`,
 *     `latencyMs`, and `consecutiveFailures` for the operator UI.
 *
 * Industry parallel: Square Terminal SDK (3-fail threshold) and Toast
 * printer monitor (60s back-off) — not invented.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandRouter } from '../../../electron/hardware/CommandRouter';
import {
  DeviceManager,
  type DeviceAssignment,
} from '../../../electron/hardware/DeviceManager';
import { EventBroker } from '../../../electron/hardware/EventBroker';
import type { HardwareEvent } from '../../../electron/hardware/types';
import type { PingResult } from '../../../electron/hardware/ping';

const handlers = {
  'receipt_printer:print_receipt': () => async () => ({ ok: true }),
};

const ASSIGNMENT: DeviceAssignment = {
  role: 'receipt_printer',
  transport: 'network',
  driver: 'escpos',
  config: { host: '10.0.0.1', port: 9100 },
  enabled: true,
};

function makePingQueue(results: PingResult[]): (() => Promise<PingResult>) {
  let i = 0;
  return () => Promise.resolve(results[Math.min(i++, results.length - 1)]);
}

describe('DeviceManager — circuit breaker liveness (Track H7a)', () => {
  let router: CommandRouter;
  let broker: EventBroker;
  let events: HardwareEvent[];

  beforeEach(() => {
    router = new CommandRouter();
    broker = new EventBroker();
    events = [];
    broker.subscribe((e) => events.push(e));
  });

  it('flips to degraded after 3 consecutive ping failures and emits device:degraded', async () => {
    const ping = makePingQueue([
      { ok: false, latencyMs: 0, error: 'timeout' },
      { ok: false, latencyMs: 0, error: 'timeout' },
      { ok: false, latencyMs: 0, error: 'timeout' },
    ]);
    const m = new DeviceManager({
      router, broker,
      loadAssignments: () => [ASSIGNMENT],
      handlers,
      healthIntervalMs: 0,
      degradedIntervalMs: 999_999,
      failureThreshold: 3,
      pingImpl: ping,
    });
    await m.bootstrap();

    // Three ticks; nominalInterval is huge so we drive ticks manually.
    await m.tick();
    await m.tick();
    await m.tick();

    const status = m.getStatuses().get('receipt_printer')!;
    expect(status.state).toBe('degraded');
    expect(status.consecutiveFailures).toBe(3);
    expect(status.lastError).toBe('timeout');

    const degraded = events.filter((e) => e.type === 'device:degraded');
    expect(degraded.length).toBe(1);
    expect((degraded[0].data as { lastError: string }).lastError).toBe('timeout');
    m.stop();
  });

  it('does NOT flip on a single transient failure (threshold guard)', async () => {
    const ping = makePingQueue([
      { ok: true, latencyMs: 5 },
      { ok: false, latencyMs: 0, error: 'transient' },
      { ok: true, latencyMs: 5 },
    ]);
    const m = new DeviceManager({
      router, broker,
      loadAssignments: () => [ASSIGNMENT],
      handlers,
      healthIntervalMs: 0,
      failureThreshold: 3,
      pingImpl: ping,
    });
    await m.bootstrap();
    await m.tick();
    await m.tick();
    await m.tick();
    const status = m.getStatuses().get('receipt_printer')!;
    expect(status.state).toBe('connected');
    expect(events.find((e) => e.type === 'device:degraded')).toBeUndefined();
    m.stop();
  });

  it('one successful ping after degraded resets the counter and emits recovery', async () => {
    const ping = makePingQueue([
      { ok: false, latencyMs: 0, error: 'down' },
      { ok: false, latencyMs: 0, error: 'down' },
      { ok: false, latencyMs: 0, error: 'down' }, // → degraded
      { ok: true, latencyMs: 8 },                  // → recovered
    ]);
    const m = new DeviceManager({
      router, broker,
      loadAssignments: () => [ASSIGNMENT],
      handlers,
      healthIntervalMs: 0,
      degradedIntervalMs: 0,
      failureThreshold: 3,
      pingImpl: ping,
    });
    await m.bootstrap();
    await m.tick();
    await m.tick();
    await m.tick();
    expect(m.getStatuses().get('receipt_printer')?.state).toBe('degraded');
    await m.tick();
    const status = m.getStatuses().get('receipt_printer')!;
    expect(status.state).toBe('connected');
    expect(status.consecutiveFailures).toBe(0);
    expect(status.latencyMs).toBe(8);

    const recovered = events.filter(
      (e) => e.type === 'device:connected' && (e.data as { recovered?: boolean } | undefined)?.recovered === true,
    );
    expect(recovered.length).toBe(1);
    m.stop();
  });

  it('degraded devices back off to the longer probe interval', async () => {
    const ping = vi.fn(async () => ({ ok: false, latencyMs: 0, error: 'down' } as PingResult));
    const m = new DeviceManager({
      router, broker,
      loadAssignments: () => [ASSIGNMENT],
      handlers,
      healthIntervalMs: 0,
      degradedIntervalMs: 999_999_999, // effectively block re-probe
      failureThreshold: 3,
      pingImpl: ping,
    });
    await m.bootstrap();
    await m.tick(); await m.tick(); await m.tick(); // → degraded
    expect(ping).toHaveBeenCalledTimes(3);
    // Further ticks should be gated by nextProbeAt and NOT re-probe.
    await m.tick();
    await m.tick();
    expect(ping).toHaveBeenCalledTimes(3);
    m.stop();
  });

  it('refresh(role) forces an immediate probe regardless of back-off', async () => {
    const ping = vi.fn(async () => ({ ok: true, latencyMs: 3 } as PingResult));
    const m = new DeviceManager({
      router, broker,
      loadAssignments: () => [ASSIGNMENT],
      handlers,
      healthIntervalMs: 999_999, // gated; refresh() must bypass
      degradedIntervalMs: 999_999,
      pingImpl: ping,
    });
    await m.bootstrap();
    await m.tick();
    expect(ping).toHaveBeenCalledTimes(1);
    const snap = await m.refresh('receipt_printer');
    expect(ping).toHaveBeenCalledTimes(2);
    expect(snap?.state).toBe('connected');
    m.stop();
  });

  it('getStatuses() returns an isolated snapshot (mutations do not leak)', async () => {
    const m = new DeviceManager({
      router, broker,
      loadAssignments: () => [ASSIGNMENT],
      handlers,
      healthIntervalMs: 999_999,
      pingImpl: async () => ({ ok: true, latencyMs: 1 }),
    });
    await m.bootstrap();
    await m.tick();
    const snap = m.getStatuses();
    snap.delete('receipt_printer');
    expect(m.getStatuses().has('receipt_printer')).toBe(true);
    m.stop();
  });
});
