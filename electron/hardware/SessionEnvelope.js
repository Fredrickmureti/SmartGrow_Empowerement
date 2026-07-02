"use strict";
/**
 * SessionEnvelope — main-process HMAC verifier for the renderer→main
 * hardware channel (ADR-0014 Track H3).
 *
 * Threat model: Electron's contextBridge already isolates the renderer
 * world from the preload world, so a 256-bit secret kept in a preload
 * closure is not accessible to renderer JS. The HMAC envelope adds three
 * orthogonal protections on top of that isolation:
 *
 *   1. **Sender pinning** — main records the `webContents.id` that owns
 *      each secret; another window (e.g. a spawned BrowserView) cannot
 *      replay an envelope it captured from a sibling.
 *   2. **Replay window** — every envelope carries a 12-byte nonce; main
 *      keeps a 5-minute LRU of seen nonces and rejects duplicates.
 *   3. **Skew bound** — `|now - ts| > 30s` is rejected, matching the
 *      existing NetworkTransport agent contract.
 *
 * The signature scheme intentionally mirrors NetworkTransport.sign so a
 * single test suite proves both ends:
 *   sig = HMAC_SHA256(secret, `${ts}.${sha256(JSON(payload)+'|'+nonce)}`)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionEnvelope = exports.SessionEnvelopeStore = void 0;
const node_crypto_1 = require("node:crypto");
const NONCE_TTL_MS = 5 * 60 * 1000;
const MAX_SKEW_S = 30;
function isEnvelope(v) {
    if (!v || typeof v !== 'object')
        return false;
    const o = v;
    return typeof o.ts === 'string'
        && typeof o.nonce === 'string'
        && typeof o.sig === 'string'
        && 'payload' in o;
}
function signCanonical(secret, ts, payloadJson, nonce) {
    const bodyHash = (0, node_crypto_1.createHash)('sha256').update(payloadJson + '|' + nonce).digest('hex');
    return (0, node_crypto_1.createHmac)('sha256', secret).update(`${ts}.${bodyHash}`).digest('hex');
}
class SessionEnvelopeStore {
    constructor(opts) {
        this.secrets = new Map(); // webContents.id → secret
        this.nonces = new Map(); // nonce → first-seen ms
        this.nowMs = opts?.now ?? (() => Date.now());
    }
    /** Mint (or fetch) the secret bound to a given webContents.id. */
    getOrCreateSecret(webContentsId) {
        let s = this.secrets.get(webContentsId);
        if (!s) {
            s = (0, node_crypto_1.randomBytes)(32).toString('hex');
            this.secrets.set(webContentsId, s);
        }
        return s;
    }
    /** Release the secret when the window goes away. */
    release(webContentsId) {
        this.secrets.delete(webContentsId);
    }
    /**
     * Verify an envelope arrived from the expected webContents.id, has a
     * fresh timestamp, an unseen nonce, and a matching signature.
     */
    verify(webContentsId, raw) {
        if (!isEnvelope(raw))
            return { ok: false, reason: 'envelope shape invalid' };
        const env = raw;
        const secret = this.secrets.get(webContentsId);
        if (!secret)
            return { ok: false, reason: 'no session secret for sender' };
        const tsNum = Number(env.ts);
        if (!Number.isFinite(tsNum))
            return { ok: false, reason: 'invalid timestamp' };
        const nowS = Math.floor(this.nowMs() / 1000);
        if (Math.abs(nowS - tsNum) > MAX_SKEW_S)
            return { ok: false, reason: 'timestamp skew exceeded' };
        this.gcNonces();
        if (this.nonces.has(env.nonce))
            return { ok: false, reason: 'nonce replay' };
        const payloadJson = JSON.stringify(env.payload ?? null);
        const expected = signCanonical(secret, env.ts, payloadJson, env.nonce);
        const a = Buffer.from(expected, 'hex');
        const b = Buffer.from(env.sig || '', 'hex');
        if (a.length !== b.length || !(0, node_crypto_1.timingSafeEqual)(a, b)) {
            return { ok: false, reason: 'signature mismatch' };
        }
        this.nonces.set(env.nonce, this.nowMs());
        return { ok: true, payload: env.payload };
    }
    gcNonces() {
        const cutoff = this.nowMs() - NONCE_TTL_MS;
        for (const [n, t] of this.nonces) {
            if (t < cutoff)
                this.nonces.delete(n);
        }
    }
    // ── Test helpers ────────────────────────────────────────────────────────
    static sign(secret, ts, payload, nonce) {
        return signCanonical(secret, ts, JSON.stringify(payload ?? null), nonce);
    }
    _injectSecret(webContentsId, secret) {
        this.secrets.set(webContentsId, secret);
    }
    _seenNonces() { return this.nonces.size; }
}
exports.SessionEnvelopeStore = SessionEnvelopeStore;
exports.sessionEnvelope = new SessionEnvelopeStore();
//# sourceMappingURL=SessionEnvelope.js.map