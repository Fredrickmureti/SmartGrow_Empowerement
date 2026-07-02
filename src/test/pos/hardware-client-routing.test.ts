/**
 * ADR-0014 Track 4b — verify `hardwareClient` routes every exec call
 * through `window.pos.hardware.exec` when running inside Electron.
 *
 * This locks the architectural invariant: in Electron, no hardware
 * command is allowed to bypass the main-process CommandRouter via the
 * renderer-side `hardwareProxy`. The test installs a stub `window.pos`
 * and asserts every public method of `hardwareClient` lands on it with
 * a non-empty `idempotencyKey`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

interface ExecCall {
  role: string;
  op: string;
  payload?: unknown;
  idempotencyKey: string;
}

describe('hardwareClient — Electron routing (Track 4b)', () => {
  const calls: ExecCall[] = [];
  let originalPos: unknown;

  beforeEach(() => {
    calls.length = 0;
    originalPos = (globalThis as { pos?: unknown }).pos;
    (globalThis as unknown as { pos: { hardware: { exec: (c: ExecCall) => Promise<{ ok: boolean; result?: unknown }> } } }).pos = {
      hardware: {
        exec: async (cmd: ExecCall) => {
          calls.push(cmd);
          return { ok: true, result: { ack: cmd.role + ':' + cmd.op } };
        },
      },
    };
    // Re-import so the module re-evaluates `ipcAvailable()`.
    vi.resetModules();
  });

  afterEach(() => {
    (globalThis as { pos?: unknown }).pos = originalPos;
  });

  it('printReceipt routes through window.pos.hardware.exec', async () => {
    const { hardwareClient } = await import('@/services/hardware/HardwareClient');
    await hardwareClient.printReceipt({ receiptData: { lines: [{ text: 'hi' }] } as never });
    expect(calls).toHaveLength(1);
    expect(calls[0].role).toBe('receipt_printer');
    expect(calls[0].op).toBe('print_receipt');
    expect(calls[0].idempotencyKey.length).toBeGreaterThan(8);
  });

  it('every exec method stamps an idempotencyKey', async () => {
    const { hardwareClient } = await import('@/services/hardware/HardwareClient');
    await hardwareClient.printReceipt({ receiptData: { lines: [] } as never });
    await hardwareClient.printKitchenOrder({ receiptData: { lines: [] } as never });
    await hardwareClient.printRawBytes(new Uint8Array([1, 2, 3]));
    await hardwareClient.openDrawer({ pin: 2 });
    await hardwareClient.readScale();
    await hardwareClient.tareScale();
    await hardwareClient.updateCustomerDisplay({ message: 'x' } as never);
    await hardwareClient.initiatePayment({ amount: 100, currency: 'KES', reference: 'r1' });
    await hardwareClient.cancelPayment();
    expect(calls).toHaveLength(9);
    for (const c of calls) expect(c.idempotencyKey.length).toBeGreaterThan(8);
  });

  it('role/op mapping is stable across the public surface', async () => {
    const { hardwareClient } = await import('@/services/hardware/HardwareClient');
    await hardwareClient.printReceipt({ receiptData: {} as never });
    await hardwareClient.printKitchenOrder({ receiptData: {} as never });
    await hardwareClient.printRawBytes([0x1b, 0x40]);
    await hardwareClient.openDrawer();
    await hardwareClient.readScale();
    await hardwareClient.tareScale();
    await hardwareClient.updateCustomerDisplay({} as never);
    await hardwareClient.initiatePayment({ amount: 1, currency: 'USD', reference: 'x' });
    await hardwareClient.cancelPayment();
    const sigs = calls.map((c) => `${c.role}:${c.op}`);
    expect(sigs).toEqual([
      'receipt_printer:print_receipt',
      'kitchen_printer:print_receipt',
      'receipt_printer:print_raw',
      'cash_drawer:open',
      'scale:read',
      'scale:tare',
      'customer_display:update',
      'payment_terminal:initiate_payment',
      'payment_terminal:cancel_payment',
    ]);
  });
});
