/**
 * Track H7a — DeviceManager must surface misconfigurations honestly.
 *
 * Two failure modes covered:
 *   1. Two enabled assignments target the same logical role
 *      → second is REJECTED, broker emits `device:misconfigured`,
 *        first wins, no silent shadowing.
 *   2. CommandRouter throws on duplicate handler registration
 *      → DeviceManager catches, logs, emits `device:misconfigured`,
 *        skips the offending assignment instead of silently moving on.
 *
 * Regression target: pre-H7a `bootstrap()` had an empty `catch {}` that
 * silently dropped the second assignment. In the field this presented
 * as "I configured a printer in settings and nothing prints" with no
 * log trail. This test locks the surface so that regression cannot
 * sneak back in.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandRouter } from '../../../electron/hardware/CommandRouter';
import {
  DeviceManager,
  type DeviceAssignment,
} from '../../../electron/hardware/DeviceManager';
import { EventBroker } from '../../../electron/hardware/EventBroker';
import type { HardwareEvent } from '../../../electron/hardware/types';

const handlers = {
  'receipt_printer:print_receipt': () => async () => ({ ok: true }),
};

function captureBroker(broker: EventBroker): HardwareEvent[] {
  const events: HardwareEvent[] = [];
  broker.subscribe((e) => events.push(e));
  return events;
}

describe('DeviceManager — misconfiguration honesty (Track H7a)', () => {
  let router: CommandRouter;
  let broker: EventBroker;
  let events: HardwareEvent[];

  beforeEach(() => {
    router = new CommandRouter();
    broker = new EventBroker();
    events = captureBroker(broker);
  });

  it('rejects a duplicate-role assignment and emits device:misconfigured', async () => {
    const assignments: DeviceAssignment[] = [
      { role: 'receipt_printer', transport: 'network', driver: 'escpos', config: { host: '10.0.0.1', port: 9100 }, enabled: true },
      { role: 'receipt_printer', transport: 'usb', driver: 'escpos', config: { vendorId: 0x04b8, productId: 0x0e15 }, enabled: true },
    ];
    const logged: string[] = [];
    const manager = new DeviceManager({
      router, broker,
      loadAssignments: () => assignments,
      handlers,
      healthIntervalMs: 999_999,
      pingImpl: async () => ({ ok: true, latencyMs: 1 }),
      logger: { error: (msg) => logged.push(msg) },
    });

    await manager.bootstrap();

    // First assignment wins.
    expect(manager.getActive().get('receipt_printer')?.transport).toBe('network');

    // Misconfig event was broadcast with the rejected transport.
    const misconfig = events.find((e) => e.type === 'device:misconfigured');
    expect(misconfig).toBeDefined();
    expect((misconfig?.data as { reason: string }).reason).toBe('duplicate_role');
    expect((misconfig?.data as { rejected: string }).rejected).toBe('usb');

    // Operator-visible log entry exists (no silent swallow).
    expect(logged.some((m) => m.includes('device:misconfigured'))).toBe(true);
    expect(logged.some((m) => m.includes('duplicate'))).toBe(true);
  });

  it('does not register handlers for the rejected duplicate', async () => {
    // Verifies a USB transport assignment is not what services the role
    // after a network assignment claimed it first. We accomplish this by
    // letting the first assignment register, then verifying the router
    // only has one handler for the role:op pair (CommandRouter throws on
    // duplicate registration, so absence-of-throw IS the proof).
    const manager = new DeviceManager({
      router, broker,
      loadAssignments: () => [
        { role: 'receipt_printer', transport: 'network', driver: 'escpos', config: { host: '10.0.0.1', port: 9100 }, enabled: true },
        { role: 'receipt_printer', transport: 'usb', driver: 'escpos', config: { vendorId: 1, productId: 1 }, enabled: true },
      ],
      handlers,
      healthIntervalMs: 999_999,
      pingImpl: async () => ({ ok: true, latencyMs: 1 }),
      logger: { error: vi.fn() },
    });

    // Should NOT throw — the duplicate is caught at the assignment-level
    // check before reaching router.register().
    await expect(manager.bootstrap()).resolves.toBeUndefined();
    expect(router.hasHandler('receipt_printer', 'print_receipt')).toBe(true);
  });

  it('surfaces router-level duplicate-handler errors as device:misconfigured', async () => {
    // Pre-register the handler so router.register() throws on the first
    // assignment that tries to claim it.
    router.register('receipt_printer', 'print_receipt', async () => ({ ok: true }));

    const logged: string[] = [];
    const manager = new DeviceManager({
      router, broker,
      loadAssignments: () => [
        { role: 'receipt_printer', transport: 'network', driver: 'escpos', config: { host: '10.0.0.1', port: 9100 }, enabled: true },
      ],
      handlers,
      healthIntervalMs: 999_999,
      pingImpl: async () => ({ ok: true, latencyMs: 1 }),
      logger: { error: (msg) => logged.push(msg) },
    });

    await manager.bootstrap();

    const misconfig = events.find((e) => e.type === 'device:misconfigured');
    expect(misconfig).toBeDefined();
    expect((misconfig?.data as { reason: string }).reason).toBe('router_register_failed');
    expect(logged.some((m) => m.includes('router_register_failed') || m.includes('Failed to register') || m.includes('failed to register'))).toBe(true);

    // The assignment with a registration failure must NOT become active.
    expect(manager.getActive().has('receipt_printer')).toBe(false);
  });

  it('disabled assignments are skipped (no misconfig event, no registration)', async () => {
    const manager = new DeviceManager({
      router, broker,
      loadAssignments: () => [
        { role: 'receipt_printer', transport: 'network', driver: 'escpos', config: { host: '10.0.0.1', port: 9100 }, enabled: false },
      ],
      handlers,
      healthIntervalMs: 999_999,
      pingImpl: async () => ({ ok: true, latencyMs: 1 }),
      logger: { error: vi.fn() },
    });
    await manager.bootstrap();
    expect(events.find((e) => e.type === 'device:misconfigured')).toBeUndefined();
    expect(manager.getActive().size).toBe(0);
  });
});
