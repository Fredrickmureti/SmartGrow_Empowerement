/**
 * Track D — driver registry smoke tests.
 *
 * Verifies each main-process driver exposes the right ops, builds via
 * the registry, and handles unknown-op gracefully. Transport IO is not
 * exercised here (would require node-usb / serialport / real hardware);
 * those paths are covered by the transport-level tests.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDriver,
  EscPosReceiptDriver,
  EscPosKitchenDriver,
  EscPosCashDrawerDriver,
  CustomerDisplayDriver,
  SerialScaleDriver,
  ClockTerminalDriver,
  MockDriver,
} from '../../../electron/hardware/drivers';
import type { DeviceAssignment } from '../../../electron/hardware/DeviceManager';

const a = (role: DeviceAssignment['role'], transport: DeviceAssignment['transport'] = 'usb'): DeviceAssignment => ({
  role, transport, driver: 'escpos', enabled: true, config: {},
});

describe('driver registry', () => {
  it('builds the right class per role', () => {
    expect(buildDriver(a('receipt_printer'))).toBeInstanceOf(EscPosReceiptDriver);
    expect(buildDriver(a('kitchen_printer'))).toBeInstanceOf(EscPosKitchenDriver);
    expect(buildDriver(a('cash_drawer'))).toBeInstanceOf(EscPosCashDrawerDriver);
    expect(buildDriver(a('customer_display'))).toBeInstanceOf(CustomerDisplayDriver);
    expect(buildDriver(a('scale', 'serial'))).toBeInstanceOf(SerialScaleDriver);
    // Wave B3.1: attendance/biometric terminals now resolve through the registry.
    expect(buildDriver(a('clock_terminal', 'network'))).toBeInstanceOf(ClockTerminalDriver);
    expect(buildDriver(a('biometric_reader', 'network'))).toBeInstanceOf(ClockTerminalDriver);
  });

  it('payment_terminal and scanner are not built by the registry', () => {
    // Payment terminal owns a FSM, not a transport — wired by Track P.
    expect(buildDriver(a('payment_terminal'))).toBeNull();
    // Scanner is renderer-side (HID/keyboard wedge).
    expect(buildDriver(a('scanner'))).toBeNull();
  });


  it('exposes the expected op surface', () => {
    expect(new EscPosReceiptDriver(a('receipt_printer')).supportedOps()).toEqual(['print_receipt']);
    expect(new EscPosKitchenDriver(a('kitchen_printer')).supportedOps()).toEqual(['print_ticket']);
    expect(new EscPosCashDrawerDriver(a('cash_drawer')).supportedOps()).toEqual(['open']);
    expect(new CustomerDisplayDriver(a('customer_display')).supportedOps()).toEqual(['update', 'show_complete', 'reset']);
    expect(new SerialScaleDriver(a('scale', 'serial')).supportedOps()).toEqual(['read_weight']);
  });

  it('rejects unsupported ops without contacting the transport', async () => {
    const d = new EscPosReceiptDriver(a('receipt_printer'));
    const r = await d.handle({ role: 'receipt_printer', op: 'open', payload: {}, idempotencyKey: 'k-12345678' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unsupported op/);
  });

  it('rejects empty payloads', async () => {
    const d = new EscPosReceiptDriver(a('receipt_printer'));
    const r = await d.handle({ role: 'receipt_printer', op: 'print_receipt', payload: {}, idempotencyKey: 'k-12345678' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing bytes\/text/);
  });
});

describe('MockDriver', () => {
  it('records every handled command and reports ok', async () => {
    const d = new MockDriver('receipt_printer');
    await d.connect();
    expect(d.state()).toBe('connected');
    const r = await d.handle({ role: 'receipt_printer', op: 'print_receipt', payload: { bytes: [1, 2, 3] }, idempotencyKey: 'k-12345678' });
    expect(r.ok).toBe(true);
    expect(d.handled).toHaveLength(1);
    expect(d.handled[0].op).toBe('print_receipt');
    await d.disconnect();
    expect(d.state()).toBe('disconnected');
  });
});
