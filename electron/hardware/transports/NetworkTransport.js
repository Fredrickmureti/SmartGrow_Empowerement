"use strict";
/**
 * NetworkTransport — main-process raw-TCP printer + agent-sidecar HMAC client.
 *
 * Two responsibilities:
 *   1. Raw TCP 9100 send for IP printers (ESC/POS over network).
 *   2. HMAC-signed POST to the optional `agent/` sidecar's `/print`
 *      endpoint when a tenant routes through a shared/network printer.
 *
 * The agent secret lives in OS keychain (keytar) in production; in tests
 * it is injected via the constructor. The signature scheme is:
 *   HMAC-SHA256(secret, `${timestamp}.${bodySha256}`)
 * Headers: `X-Lovable-Timestamp`, `X-Lovable-Signature`. Agent rejects
 * skew > 30 s and any mismatched body hash.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.NetworkTransport = void 0;
const node_crypto_1 = require("node:crypto");
const nodenet = __importStar(require("node:net"));
class NetworkTransport {
    /** Open a TCP connection, write ESC/POS bytes, close. Returns bytes written. */
    static rawSend(target, bytes) {
        return new Promise(resolve => {
            const socket = new nodenet.Socket();
            const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
            let settled = false;
            const finish = (r) => {
                if (settled)
                    return;
                settled = true;
                try {
                    socket.destroy();
                }
                catch { /* noop */ }
                resolve(r);
            };
            socket.setTimeout(target.timeoutMs ?? 5000, () => finish({ ok: false, error: 'timeout' }));
            socket.once('error', (err) => finish({ ok: false, error: err.message }));
            socket.connect(target.port, target.host, () => {
                socket.write(payload, (err) => {
                    if (err)
                        return finish({ ok: false, error: err.message });
                    socket.end(() => finish({ ok: true, bytes: payload.length }));
                });
            });
        });
    }
    /**
     * Non-destructive liveness probe — TCP connect + immediate close.
     * Returns latency in ms on success. Used by DeviceManager's ping loop;
     * never writes data so it cannot accidentally trigger a print job.
     */
    static testConnect(target) {
        return new Promise(resolve => {
            const socket = new nodenet.Socket();
            const started = Date.now();
            let settled = false;
            const finish = (r) => {
                if (settled)
                    return;
                settled = true;
                try {
                    socket.destroy();
                }
                catch { /* noop */ }
                resolve(r);
            };
            socket.setTimeout(target.timeoutMs ?? 1500, () => finish({ ok: false, error: 'timeout' }));
            socket.once('error', (err) => finish({ ok: false, error: err.message }));
            socket.connect(target.port, target.host, () => finish({ ok: true, latencyMs: Date.now() - started }));
        });
    }
    /** Sign + POST a print job to the agent sidecar. */
    static async sendToAgent(target, path, body) {
        const raw = JSON.stringify(body ?? {});
        const ts = Math.floor(Date.now() / 1000).toString();
        const sig = NetworkTransport.sign(target.secret, ts, raw);
        const fetchImpl = target.fetchImpl ?? fetch;
        try {
            const res = await fetchImpl(`${target.baseUrl.replace(/\/$/, '')}${path}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Lovable-Timestamp': ts,
                    'X-Lovable-Signature': sig,
                },
                body: raw,
            });
            const text = await res.text();
            const parsed = text ? safeJsonParse(text) : null;
            return { ok: res.ok, status: res.status, result: parsed ?? text };
        }
        catch (err) {
            return { ok: false, status: 0, error: err.message };
        }
    }
    /** Stable signature: hex(HMAC-SHA256(secret, `${ts}.${sha256(body)}`)). */
    static sign(secret, timestamp, body) {
        const bodyHash = (0, node_crypto_1.createHash)('sha256').update(body).digest('hex');
        return (0, node_crypto_1.createHmac)('sha256', secret).update(`${timestamp}.${bodyHash}`).digest('hex');
    }
    /** Constant-time verify with timestamp-skew enforcement. */
    static verify(secret, timestamp, body, signature, opts) {
        const skew = opts?.maxSkewSeconds ?? 30;
        const now = (opts?.now ?? (() => Math.floor(Date.now() / 1000)))();
        const tsNum = Number(timestamp);
        if (!Number.isFinite(tsNum))
            return { ok: false, reason: 'invalid timestamp' };
        if (Math.abs(now - tsNum) > skew)
            return { ok: false, reason: 'timestamp skew exceeded' };
        const expected = NetworkTransport.sign(secret, timestamp, body);
        const a = Buffer.from(expected, 'hex');
        const b = Buffer.from(signature || '', 'hex');
        if (a.length !== b.length)
            return { ok: false, reason: 'signature length mismatch' };
        return (0, node_crypto_1.timingSafeEqual)(a, b) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
    }
}
exports.NetworkTransport = NetworkTransport;
function safeJsonParse(s) {
    try {
        return JSON.parse(s);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=NetworkTransport.js.map