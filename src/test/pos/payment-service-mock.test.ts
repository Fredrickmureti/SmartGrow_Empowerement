import { describe, it, expect } from 'vitest';
import { PaymentService, InMemoryPaymentLogStore } from '../../../electron/hardware/payment/PaymentService';
import { MockTerminalDriver } from '../../../electron/hardware/payment/MockTerminalDriver';
import { SettlementReconciler } from '../../../electron/hardware/payment/SettlementReconciler';

function make() {
  const driver = new MockTerminalDriver();
  const store = new InMemoryPaymentLogStore();
  const svc = new PaymentService({ driver, store });
  return { driver, store, svc };
}

describe('PaymentService + MockTerminalDriver (Track P)', () => {
  it('approves a standard charge and writes a log row', async () => {
    const { svc, store } = make();
    const r = await svc.charge({ amountCents: 1500, currency: 'USD', idempotencyKey: 'pay-1' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('approved');
    expect(r.authId).toBe('pay-1:auth');
    expect(store._all()).toHaveLength(1);
    expect(store._all()[0].state).toBe('approved');
  });

  it('declines $0.99 with insufficient funds', async () => {
    const { svc } = make();
    const r = await svc.charge({ amountCents: 99, currency: 'USD', idempotencyKey: 'pay-2' });
    expect(r.ok).toBe(false);
    expect(r.state).toBe('declined');
    expect(r.reason).toMatch(/insufficient/);
  });

  it('errors on $666.00 and rejects invalid amounts', async () => {
    const { svc } = make();
    const a = await svc.charge({ amountCents: 66_600, currency: 'USD', idempotencyKey: 'pay-3' });
    expect(a.state).toBe('error');
    const b = await svc.charge({ amountCents: 0, currency: 'USD', idempotencyKey: 'pay-4' });
    expect(b.state).toBe('error');
  });

  it('is idempotent by key — second charge returns cached result without dispatch', async () => {
    const { svc, store } = make();
    const a = await svc.charge({ amountCents: 1500, currency: 'USD', idempotencyKey: 'pay-5' });
    const b = await svc.charge({ amountCents: 9999, currency: 'USD', idempotencyKey: 'pay-5' });
    expect(b.state).toBe(a.state);
    expect(b.authId).toBe(a.authId);
    expect(store._all()).toHaveLength(1);
  });

  it('settlement reconciler captures approved-but-uncaptured rows older than threshold', async () => {
    const { svc, store } = make();
    await svc.charge({ amountCents: 1500, currency: 'USD', idempotencyKey: 'pay-6' });
    // Force the row's updated_at into the past.
    store._all()[0].updated_at = Date.now() - 25 * 60 * 60 * 1000;
    const rec = new SettlementReconciler({ service: svc, store });
    const r = await rec.runOnce();
    expect(r.captured).toBe(1);
    expect(store._all()[0].state).toBe('captured');
  });

  it('capture/void/refund respect FSM order', async () => {
    const { svc } = make();
    await svc.charge({ amountCents: 5000, currency: 'USD', idempotencyKey: 'pay-7' });
    const bad = await svc.refund('pay-7:auth', 100);
    expect(bad.ok).toBe(false); // cannot refund from approved
    const cap = await svc.capture('pay-7:auth');
    expect(cap.ok).toBe(true);
    const refundOk = await svc.refund('pay-7:auth', 100);
    expect(refundOk.ok).toBe(true);
  });
});