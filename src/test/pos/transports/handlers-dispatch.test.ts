/**
 * Track 3b — HARDWARE_HANDLERS dispatch covers every supported transport.
 *
 * Stubs the four native-binding transports plus NetworkTransport and asserts
 * that a receipt-print + drawer-kick + display-update + scale-read reach the
 * intended transport with the right bytes. Any future `notWiredYet`
 * regression fails this test loudly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandRouter } from '../../../../electron/hardware/CommandRouter';
import { DeviceManager, type DeviceAssignment } from '../../../../electron/hardware/DeviceManager';
import { EventBroker } from '../../../../electron/hardware/EventBroker';
import { HARDWARE_HANDLERS } from '../../../../electron/hardware/handlers';
import { NetworkTransport } from '../../../../electron/hardware/transports/NetworkTransport';
import { UsbTransport } from '../../../../electron/hardware/transports/UsbTransport';
import { SerialTransport } from '../../../../electron/hardware/transports/SerialTransport';
import { CupsTransport } from '../../../../electron/hardware/transports/CupsTransport';
import { WinSpoolerTransport } from '../../../../electron/hardware/transports/WinSpoolerTransport';

const idem = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, '0')}`;

function bootWith(assignments: DeviceAssignment[]) {
  const router = new CommandRouter();
  const broker = new EventBroker();
  const m = new DeviceManager({
    router, broker,
    loadAssignments: () => assignments,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlers: HARDWARE_HANDLERS as any,
    healthIntervalMs: 999_999,
  });
  return { router, broker, manager: m };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(NetworkTransport, 'rawSend').mockResolvedValue({ ok: true, bytes: 1 });
  vi.spyOn(UsbTransport, 'send').mockResolvedValue({ ok: true, bytes: 1 });
  vi.spyOn(SerialTransport, 'send').mockResolvedValue({ ok: true, bytes: 1 });
  vi.spyOn(CupsTransport, 'send').mockResolvedValue({ ok: true, bytes: 1 });
  vi.spyOn(WinSpoolerTransport, 'send').mockResolvedValue({ ok: true, bytes: 1 });
});

describe('HARDWARE_HANDLERS dispatch — receipt printer', () => {
  it.each([
    ['network',  { host: '10.0.0.5', port: 9100 }, NetworkTransport, 'rawSend' as const],
    ['usb',      { vendorId: 0x04b8, productId: 0x0202 }, UsbTransport, 'send' as const],
    ['serial',   { path: '/dev/ttyUSB0', baudRate: 19200 }, SerialTransport, 'send' as const],
    ['cups',     { queue: 'TM-T20' }, CupsTransport, 'send' as const],
    ['winspool', { printer: 'EPSON TM-T20' }, WinSpoolerTransport, 'send' as const],
  ])('routes print_receipt over %s', async (transport, config, mod, method) => {
    const { router, manager } = bootWith([{
      role: 'receipt_printer',
      transport: transport as DeviceAssignment['transport'],
      driver: 'escpos',
      config,
      enabled: true,
    }]);
    await manager.bootstrap();
    const r = await router.exec({
      role: 'receipt_printer',
      op: 'print_receipt',
      payload: { bytes: [0x1B, 0x40, 0x48, 0x49] },
      idempotencyKey: idem(transport),
    });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mod as any)[method]).toHaveBeenCalledTimes(1);
  });

  it('rejects bluetooth transport with a structured error (Track A2 pending)', async () => {
    const { router, manager } = bootWith([{
      role: 'receipt_printer',
      transport: 'bluetooth',
      driver: 'escpos',
      config: { mac: 'AA:BB:CC:DD:EE:FF' },
      enabled: true,
    }]);
    await manager.bootstrap();
    const r = await router.exec({
      role: 'receipt_printer',
      op: 'print_receipt',
      payload: { bytes: [0x1B, 0x40] },
      idempotencyKey: idem('bt'),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bluetooth/i);
  });

  it('rejects browser transport on the main process', async () => {
    const { router, manager } = bootWith([{
      role: 'receipt_printer',
      transport: 'browser',
      driver: 'escpos',
      config: {},
      enabled: true,
    }]);
    await manager.bootstrap();
    const r = await router.exec({
      role: 'receipt_printer',
      op: 'print_receipt',
      payload: { bytes: [0x1B, 0x40] },
      idempotencyKey: idem('br'),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/browser/);
  });

  it('surfaces missing transport config as a structured error', async () => {
    const { router, manager } = bootWith([{
      role: 'receipt_printer',
      transport: 'usb',
      driver: 'escpos',
      config: { /* vendorId / productId omitted */ },
      enabled: true,
    }]);
    await manager.bootstrap();
    const r = await router.exec({
      role: 'receipt_printer',
      op: 'print_receipt',
      payload: { bytes: [0x1B, 0x40] },
      idempotencyKey: idem('cfg'),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/vendorId\/productId/);
  });
});

describe('HARDWARE_HANDLERS dispatch — cash drawer', () => {
  it('kicks the drawer over USB with the standard ESC/POS bytes', async () => {
    const { router, manager } = bootWith([{
      role: 'cash_drawer',
      transport: 'usb',
      driver: 'escpos',
      config: { vendorId: 0x04b8, productId: 0x0202 },
      enabled: true,
    }]);
    await manager.bootstrap();
    const r = await router.exec({
      role: 'cash_drawer',
      op: 'open',
      payload: { pin: 2 },
      idempotencyKey: idem('k1'),
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe('kicked');
    const call = vi.mocked(UsbTransport.send).mock.calls[0]!;
    const buf = call[1] as Buffer;
    expect(buf[0]).toBe(0x1B);
    expect(buf[1]).toBe(0x70);
    expect(buf[2]).toBe(2);
  });
});

describe('HARDWARE_HANDLERS dispatch — customer display', () => {
  it('writes display lines over serial', async () => {
    const { router, manager } = bootWith([{
      role: 'customer_display',
      transport: 'serial',
      driver: 'line-display',
      config: { path: '/dev/ttyS1', baudRate: 9600 },
      enabled: true,
    }]);
    await manager.bootstrap();
    const r = await router.exec({
      role: 'customer_display',
      op: 'update',
      payload: { lines: ['TOTAL', '$ 12.34'] },
      idempotencyKey: idem('d1'),
    });
    expect(r.ok).toBe(true);
    expect(SerialTransport.send).toHaveBeenCalledTimes(1);
  });
});

describe('HARDWARE_HANDLERS dispatch — scale', () => {
  it('rejects scale read over non-serial transports', async () => {
    const { router, manager } = bootWith([{
      role: 'scale',
      transport: 'usb',
      driver: 'serial-scale',
      config: { vendorId: 1, productId: 2 },
      enabled: true,
    }]);
    await manager.bootstrap();
    const r = await router.exec({
      role: 'scale',
      op: 'read_weight',
      payload: {},
      idempotencyKey: idem('s1'),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/serial/);
  });
});