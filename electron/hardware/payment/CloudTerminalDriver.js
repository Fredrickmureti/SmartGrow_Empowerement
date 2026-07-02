"use strict";
/**
 * CloudTerminalDriver — generic adapter that routes terminal commands
 * through the `terminal-outbound` Supabase edge function instead of
 * talking to a native vendor SDK directly.
 *
 * This is the "cloud-mode" path that lets the SaleSaga work end-to-end
 * with tenant-owned credentials before any per-vendor native SDK is
 * pulled into the Electron bundle. Per-vendor native drivers
 * (`StripeTerminalDriver`, `AdyenTerminalDriver`, …) land in follow-up
 * loops and replace this class on a per-Company basis.
 *
 * Lifecycle:
 *   • `charge()` → invokes `terminal-outbound?action=create_intent`
 *   • `capture()/voidAuth()/refund()` → corresponding edge actions
 *   • `getStatus()` → `terminal-outbound?action=health`
 *
 * The driver is constructed with an injectable `invoke` so it can be
 * unit-tested without an HTTP runtime.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CloudTerminalDriver = void 0;
function statusToTxn(s) {
    switch (s) {
        case 'pending':
        case 'processing': return 'authorizing';
        case 'requires_capture':
        case 'authorized': return 'approved';
        case 'succeeded':
        case 'completed': return 'captured';
        case 'cancelled': return 'cancelled';
        case 'failed': return 'declined';
        case 'refunded': return 'refunded';
        default: return 'error';
    }
}
class CloudTerminalDriver {
    constructor(opts) {
        this.lastPaymentRequestId = null;
        this.vendor = opts.vendor;
        this.configId = opts.configId;
        this.invoke = opts.invoke;
    }
    async charge(req) {
        const res = await this.invoke('create_intent', {
            configId: this.configId,
            amount: req.amountCents / 100,
            currency: req.currency,
            posTransactionId: req.metadata?.posOrderId ?? null,
        });
        if (!res.success || !res.paymentRequest) {
            return { ok: false, state: 'error', reason: res.error };
        }
        this.lastPaymentRequestId = res.paymentRequest.id;
        return {
            ok: true,
            state: statusToTxn(res.paymentRequest.status),
            authId: res.paymentRequest.id,
            vendorTxnId: res.paymentRequest.provider_reference ?? undefined,
            amountCents: Math.round(res.paymentRequest.amount * 100),
            currency: res.paymentRequest.currency,
        };
    }
    async capture(authId) {
        const res = await this.invoke('capture', { paymentRequestId: authId });
        return { ok: !!res.success, state: statusToTxn(res.status), authId, reason: res.error };
    }
    async voidAuth(authId) {
        const res = await this.invoke('cancel', { paymentRequestId: authId });
        return { ok: !!res.success, state: statusToTxn(res.status), authId, reason: res.error };
    }
    async refund(authId, amountCents) {
        const res = await this.invoke('refund', { paymentRequestId: authId, amount: amountCents / 100 });
        return { ok: !!res.success, state: statusToTxn(res.status), authId, reason: res.error };
    }
    async cancelInFlight() {
        if (this.lastPaymentRequestId) {
            await this.invoke('cancel', { paymentRequestId: this.lastPaymentRequestId }).catch(() => { });
        }
    }
    async getStatus() {
        const res = await this.invoke('health', { configId: this.configId });
        return { ready: !!res.success, reason: res.error };
    }
}
exports.CloudTerminalDriver = CloudTerminalDriver;
//# sourceMappingURL=CloudTerminalDriver.js.map