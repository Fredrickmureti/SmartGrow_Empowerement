/**
 * CloudTerminalDriver — unit tests for the cloud-mode payment adapter.
 * Verifies the driver translates edge-function responses into the
 * IPaymentTerminalDriver contract correctly, without an HTTP runtime.
 */

import { describe, it, expect, vi } from 'vitest';
import { CloudTerminalDriver } from '../../../electron/hardware/payment/CloudTerminalDriver';

function makeInvoke(responses: Record<string, any>) {
  return vi.fn(async (action: string) => responses[action] ?? { success: false, error: 'no stub' });
}

describe('CloudTerminalDriver', () => {
  it('charge() maps create_intent into an authorizing/approved AuthResult', async () => {
    const invoke = makeInvoke({
      create_intent: {
        success: true,
        paymentRequest: {
          id: 'pr_1', provider_reference: 'pi_1',
          status: 'processing', amount: 12.34, currency: 'USD',
        },
      },
    });
    const drv = new CloudTerminalDriver({ vendor: 'stripe_terminal', configId: 'cfg_1', invoke });
    const res = await drv.charge({
      amountCents: 1234, currency: 'USD', idempotencyKey: 'k1',
      metadata: { posOrderId: 'order_1' },
    });
    expect(res.ok).toBe(true);
    expect(res.state).toBe('authorizing');
    expect(res.authId).toBe('pr_1');
    expect(res.vendorTxnId).toBe('pi_1');
    expect(res.amountCents).toBe(1234);
    expect(invoke).toHaveBeenCalledWith('create_intent', {
      configId: 'cfg_1', amount: 12.34, currency: 'USD', posTransactionId: 'order_1',
    });
  });

  it('capture() maps succeeded → captured', async () => {
    const invoke = makeInvoke({ capture: { success: true, status: 'succeeded' } });
    const drv = new CloudTerminalDriver({ vendor: 'stripe_terminal', configId: 'cfg_1', invoke });
    const r = await drv.capture('pr_1');
    expect(r.ok).toBe(true);
    expect(r.state).toBe('captured');
  });

  it('voidAuth() maps cancelled', async () => {
    const invoke = makeInvoke({ cancel: { success: true, status: 'cancelled' } });
    const drv = new CloudTerminalDriver({ vendor: 'adyen', configId: 'cfg_2', invoke });
    const r = await drv.voidAuth('pr_2');
    expect(r.state).toBe('cancelled');
  });

  it('refund() forwards amount in major units', async () => {
    const invoke = makeInvoke({ refund: { success: true, status: 'refunded' } });
    const drv = new CloudTerminalDriver({ vendor: 'stripe_terminal', configId: 'cfg_1', invoke });
    await drv.refund('pr_1', 500);
    expect(invoke).toHaveBeenCalledWith('refund', { paymentRequestId: 'pr_1', amount: 5 });
  });

  it('getStatus() reports unhealthy when health action returns success:false', async () => {
    const invoke = makeInvoke({ health: { success: false, error: 'No credentials' } });
    const drv = new CloudTerminalDriver({ vendor: 'stripe_terminal', configId: 'cfg_1', invoke });
    const s = await drv.getStatus();
    expect(s.ready).toBe(false);
    expect(s.reason).toMatch(/No credentials/);
  });

  it('charge() reports error on failed edge invocation', async () => {
    const invoke = makeInvoke({ create_intent: { success: false, error: 'Vendor down' } });
    const drv = new CloudTerminalDriver({ vendor: 'stripe_terminal', configId: 'cfg_1', invoke });
    const r = await drv.charge({ amountCents: 100, currency: 'USD', idempotencyKey: 'k' });
    expect(r.ok).toBe(false);
    expect(r.state).toBe('error');
    expect(r.reason).toBe('Vendor down');
  });
});
