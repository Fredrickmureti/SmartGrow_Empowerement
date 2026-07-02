/**
 * ADR-0014 Track 2 — DeviceManager bootstrap closes the "unknown op" gap.
 *
 * Before Track 2, the SaleSaga enqueued `receipt_printer:print_receipt`
 * and `cash_drawer:open` against a CommandRouter that had zero registered
 * handlers — every command dead-lettered. This test boots a DeviceManager
 * with a real assignment row (using the in-package handler factory) and
 * verifies the saga's exact (role, op) pairs now resolve, end-to-end,
 * without hitting a real network printer (we stub NetworkTransport).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandRouter } from '../../../electron/hardware/CommandRouter';
import { DeviceManager, type DeviceAssignment } from '../../../electron/hardware/DeviceManager';
import { EventBroker } from '../../../electron/hardware/EventBroker';
import { HARDWARE_HANDLERS } from '../../../electron/hardware/handlers';
import { NetworkTransport } from '../../../electron/hardware/transports/NetworkTransport';

const idem = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, '0')}`;

describe('Track 2 — DeviceManager bootstrap registers saga ops', () => {
  let router: CommandRouter;
  let broker: EventBroker;
  let manager: DeviceManager;

  beforeEach(async () => {
    router = new CommandRouter();
    broker = new EventBroker();

    const assignments: DeviceAssignment[] = [
      {
        role: 'receipt_printer',
        transport: 'network',
        driver: 'escpos',
        config: { host: '127.0.0.1', port: 9100 },
        enabled: true,
      },
      {
        role: 'cash_drawer',
        transport: 'network',
        driver: 'escpos',
        config: { host: '127.0.0.1', port: 9100 },
        enabled: true,
      },
    ];

    manager = new DeviceManager({
      router,
      broker,
      loadAssignments: () => assignments,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handlers: HARDWARE_HANDLERS as any,
      healthIntervalMs: 999_999,
    });
    await manager.bootstrap();

    // Stub the actual TCP write so we don't touch the network.
    vi.spyOn(NetworkTransport, 'rawSend').mockResolvedValue({ ok: true, bytes: 12 });
  });

  it('registers receipt_printer:print_receipt for an active assignment', () => {
    expect(router.hasHandler('receipt_printer', 'print_receipt')).toBe(true);
  });

  it('registers cash_drawer:open for an active assignment', () => {
    expect(router.hasHandler('cash_drawer', 'open')).toBe(true);
  });

  it('does NOT register payment_terminal when no assignment exists', () => {
    expect(router.hasHandler('payment_terminal', 'charge')).toBe(false);
  });

  it('dispatches print_receipt end-to-end (no "unknown op")', async () => {
    const res = await router.exec({
      role: 'receipt_printer',
      op: 'print_receipt',
      payload: { bytes: [0x1B, 0x40, 0x48, 0x49] },
      idempotencyKey: idem('1'),
    });
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(NetworkTransport.rawSend).toHaveBeenCalledTimes(1);
  });

  it('dispatches drawer:open with standard ESC/POS kick bytes', async () => {
    const res = await router.exec({
      role: 'cash_drawer',
      op: 'open',
      payload: { pin: 2 },
      idempotencyKey: idem('2'),
    });
    expect(res.ok).toBe(true);
    expect(res.result).toBe('kicked');
    const calls = vi.mocked(NetworkTransport.rawSend).mock.calls;
    const call = calls[calls.length - 1];
    // First three bytes of the kick command: ESC 'p' pin
    const bytes = call![1] as Buffer;
    expect(bytes[0]).toBe(0x1B);
    expect(bytes[1]).toBe(0x70);
    expect(bytes[2]).toBe(2);
  });

  it('returns a structured error when payload is missing print bytes', async () => {
    const res = await router.exec({
      role: 'receipt_printer',
      op: 'print_receipt',
      payload: {},
      idempotencyKey: idem('3'),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/missing/);
  });

  it('rejects when network config is missing host', async () => {
    // Re-bootstrap with bad config to prove guard rails are real.
    const router2 = new CommandRouter();
    const m2 = new DeviceManager({
      router: router2,
      broker: new EventBroker(),
      loadAssignments: () => [{
        role: 'receipt_printer',
        transport: 'network',
        driver: 'escpos',
        config: {},
        enabled: true,
      }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handlers: HARDWARE_HANDLERS as any,
      healthIntervalMs: 999_999,
    });
    await m2.bootstrap();
    const res = await router2.exec({
      role: 'receipt_printer',
      op: 'print_receipt',
      payload: { bytes: [0x1B] },
      idempotencyKey: idem('4'),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/host/);
  });
});
