/**
 * Op-handler factory used by DeviceManager.
 *
 * Track D (ADR-0014): collapsed from 240 LOC of inline byte assembly to
 * a thin per-assignment dispatcher that delegates to typed driver
 * classes under `electron/hardware/drivers/`. The drivers own ESC/POS
 * encoding, cash-drawer kick framing, VFD line formatting and serial
 * scale frame parsing. Transport selection remains in `TransportDriver`.
 *
 * Bluetooth (Track B) and payment_terminal FSM (Track P) wiring is
 * deferred — those tracks land in the next loop.
 */

import type { OpHandler } from '../CommandRouter';
import type { DeviceAssignment } from '../DeviceManager';
import type { ExecResult } from '../types';
import { buildDriver } from '../drivers';
import type { IDriver } from '../drivers';
import type { PaymentService } from '../payment/PaymentService';

/**
 * Track P — the payment service is wired by `electron/main.ts` after the
 * SQLite-backed store is available. Until then `paymentVendor` returns a
 * clear error rather than crashing.
 */
let _paymentService: PaymentService | null = null;
export function setPaymentService(svc: PaymentService | null): void {
  _paymentService = svc;
}
export function getPaymentService(): PaymentService | null { return _paymentService; }

/**
 * One driver instance per assignment, memoised so repeated op invocations
 * share connect/disconnect lifecycle. DeviceManager owns the assignment
 * lifetime so this cache is implicitly bounded.
 */
const driverCache = new WeakMap<DeviceAssignment, IDriver>();

function driverFor(a: DeviceAssignment): IDriver | null {
  const cached = driverCache.get(a);
  if (cached) return cached;
  const d = buildDriver(a);
  if (d) driverCache.set(a, d);
  return d;
}

/** Build a handler that delegates to the driver's `handle(cmd)`. */
function makeOpHandler(a: DeviceAssignment, op: string): OpHandler {
  return async (cmd): Promise<ExecResult> => {
    const driver = driverFor(a);
    if (!driver) {
      return {
        ok: false,
        error: `no driver for role '${a.role}'. ` +
          (a.role === 'payment_terminal'
            ? 'Payment terminal FSM lands in Track P; vendor adapter (Stripe/Adyen) pending.'
            : `Register a driver in electron/hardware/drivers/index.ts.`),
      };
    }
    if (!driver.supportedOps().includes(op)) {
      return { ok: false, error: `driver for '${a.role}' does not support op '${op}'` };
    }
    return driver.handle(cmd);
  };
}

// Synthetic GL ack — saga housekeeping. GL posting is performed by the
// renderer against Supabase; this handler records the saga step.
// Idempotency comes from the queue's idempotency_key.
const glPostAck = (_a: DeviceAssignment): OpHandler => async () => {
  return { ok: true, result: { recorded: true, note: 'GL post acknowledged by saga; actual posting is renderer-side.' } };
};

// Payment terminal vendor ops — routed through PaymentService when wired.
// Default driver is MockTerminalDriver (deterministic test/dev rules); real
// vendor adapters (Stripe Terminal, Adyen) plug into PaymentService via
// `setPaymentService(...).swapDriver(...)` in a follow-up loop.
const paymentOp = (op: 'charge' | 'capture' | 'void' | 'refund' | 'status'): (a: DeviceAssignment) => OpHandler =>
  (_a) => async (cmd) => {
    const svc = _paymentService;
    if (!svc) {
      return { ok: false, error: `payment service not initialised (call setPaymentService) — op ${op}` };
    }
    try {
      const p = (cmd.payload ?? {}) as Record<string, unknown>;
      if (op === 'charge') {
        const amount = Number(p.amountCents);
        const currency = String(p.currency ?? 'USD');
        const r = await svc.charge({
          amountCents: amount, currency,
          idempotencyKey: cmd.idempotencyKey,
          posOrderId: p.posOrderId as string | undefined,
          metadata: (p.metadata as Record<string, string> | undefined),
        });
        return r.ok ? { ok: true, result: r } : { ok: false, error: r.reason ?? `state=${r.state}`, result: r };
      }
      if (op === 'capture') {
        const r = await svc.capture(String(p.authId));
        return r.ok ? { ok: true, result: r } : { ok: false, error: r.reason, result: r };
      }
      if (op === 'void') {
        const r = await svc.voidAuth(String(p.authId));
        return r.ok ? { ok: true, result: r } : { ok: false, error: r.reason, result: r };
      }
      if (op === 'refund') {
        const r = await svc.refund(String(p.authId), Number(p.amountCents));
        return r.ok ? { ok: true, result: r } : { ok: false, error: r.reason, result: r };
      }
      const s = await svc.getStatus();
      return s.ready ? { ok: true, result: s } : { ok: false, error: s.reason, result: s };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };

export const HARDWARE_HANDLERS: Record<string, (a: DeviceAssignment) => OpHandler> = {
  'receipt_printer:print_receipt': (a) => makeOpHandler(a, 'print_receipt'),
  // Audit Wave 9d.3 — `printRawBytes` in HardwareClient emits this op; without
  // a registered handler every server-rendered ESC/POS receipt failed in
  // Electron with "unknown op: receipt_printer:print_raw".
  'receipt_printer:print_raw': (a) => makeOpHandler(a, 'print_raw'),

  // Audit Wave 9d.8 — canonical kitchen op is `print_receipt`. The legacy
  // `print_ticket` IPC key is kept as a transparent alias for older
  // renderer builds; both route into the driver's single canonical
  // handler so there is no behaviour drift.
  'kitchen_printer:print_receipt': (a) => makeOpHandler(a, 'print_receipt'),
  'kitchen_printer:print_ticket': (a) => makeOpHandler(a, 'print_receipt'),

  // Audit Wave 9d.3 — `label_printer` is now first-class. `print_raw`
  // matches `useInventoryLabelPrinter.printLabelBytes` once it stops
  // pretending to be a receipt printer; `print_label` is reserved for the
  // future ZPL/EPL renderer.
  'label_printer:print_raw': (a) => makeOpHandler(a, 'print_raw'),
  'label_printer:print_receipt': (a) => makeOpHandler(a, 'print_receipt'),
  'label_printer:print_label': (a) => makeOpHandler(a, 'print_label'),

  'cash_drawer:open': (a) => makeOpHandler(a, 'open'),
  'customer_display:update': (a) => makeOpHandler(a, 'update'),
  'customer_display:show_complete': (a) => makeOpHandler(a, 'show_complete'),
  'customer_display:reset': (a) => makeOpHandler(a, 'reset'),
  'scale:read_weight': (a) => makeOpHandler(a, 'read_weight'),
  // saga housekeeping — replaces legacy `payment_terminal:post_gl`.
  'saga:post_gl': glPostAck,
  // Backwards-compat: legacy outbox rows that pre-date Track P still
  // dispatch via the old key until replayed/re-enqueued.
  'payment_terminal:post_gl': glPostAck,
  // payment_terminal vendor ops — Track P live.
  'payment_terminal:charge': paymentOp('charge'),
  'payment_terminal:void': paymentOp('void'),
  'payment_terminal:refund': paymentOp('refund'),
  'payment_terminal:capture': paymentOp('capture'),
  'payment_terminal:status': paymentOp('status'),
};
