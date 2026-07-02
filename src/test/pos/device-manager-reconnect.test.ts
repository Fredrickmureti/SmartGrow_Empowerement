/**
 * Track H7c — per-role reconnect.
 *
 * The pre-H7c `pos:devices:reconnect` IPC handler re-bootstrapped the
 * entire DeviceManager for any role, which transiently tore down
 * sibling handlers (clicking "Reconnect" on the scale would briefly
 * drop the receipt printer). DeviceManager.refresh(role) forces an
 * immediate probe of just the named role without touching the others.
 *
 * This test pins:
 *   • refresh(role) re-probes only the named device
 *   • sibling handlers stay registered across the call
 *   • refresh(unknown role) returns null (handler returns error envelope)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CommandRouter } from '../../../electron/hardware/CommandRouter';
import {
  DeviceManager,
  type DeviceAssignment,
} from '../../../electron/hardware/DeviceManager';
import { EventBroker } from '../../../electron/hardware/EventBroker';
import type { PingResult } from '../../../electron/hardware/ping';

const handlers = {
  'receipt_printer:print_receipt': () => async () => ({ ok: true }),
  'scale:read_weight': () => async () => ({ ok: true, result: { grams: 0 } }),
};

const RECEIPT: DeviceAssignment = {
  role: 'receipt_printer',
  transport: 'network',
  driver: 'escpos',
  config: { host: '10.0.0.1', port: 9100 },
  enabled: true,
};
const SCALE: DeviceAssignment = {
  role: 'scale',
  transport: 'serial',
  driver: 'cas',
  config: { path: '/dev/null', baud: 9600 },
  enabled: true,
};

describe('DeviceManager — per-role reconnect (Track H7c)', () => {
  let router: CommandRouter;
  let broker: EventBroker;

  beforeEach(() => {
    router = new CommandRouter();
    broker = new EventBroker();
  });

  it('refresh(scale) re-probes only the scale and leaves receipt_printer handlers intact', async () => {
    const calls: string[] = [];
    const ping = async (a: DeviceAssignment): Promise<PingResult> => {
      calls.push(a.role);
      return { ok: true, latencyMs: 5 };
    };
    const m = new DeviceManager({
      router, broker,
      loadAssignments: () => [RECEIPT, SCALE],
      handlers,
      healthIntervalMs: 999_999,
      pingImpl: ping,
    });
    await m.bootstrap();

    // Sibling handler is registered after bootstrap.
    expect(router.hasHandler('receipt_printer', 'print_receipt')).toBe(true);
    expect(router.hasHandler('scale', 'read_weight')).toBe(true);
    calls.length = 0;

    const status = await m.refresh('scale');
    expect(status?.state).toBe('connected');
    // Only scale was probed.
    expect(calls).toEqual(['scale']);
    // Sibling handler untouched.
    expect(router.hasHandler('receipt_printer', 'print_receipt')).toBe(true);
    expect(router.hasHandler('scale', 'read_weight')).toBe(true);
  });

  it('refresh(unknown role) returns null without crashing or affecting siblings', async () => {
    const m = new DeviceManager({
      router, broker,
      loadAssignments: () => [RECEIPT],
      handlers,
      healthIntervalMs: 999_999,
      pingImpl: async () => ({ ok: true, latencyMs: 1 }),
    });
    await m.bootstrap();
    const status = await m.refresh('payment_terminal' as never);
    expect(status).toBeNull();
    expect(router.hasHandler('receipt_printer', 'print_receipt')).toBe(true);
  });
});