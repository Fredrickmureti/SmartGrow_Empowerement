"use strict";
/**
 * BluetoothPairingManager — vendor-agnostic FSM + reconnect orchestrator.
 *
 * State machine:
 *   disconnected → discovering → pairing → paired
 *                                ↓
 *                              error / disconnected
 *   paired → connecting → connected
 *                   ↓
 *               reconnecting (with exponential backoff)
 *   reconnecting → connecting → connected | reconnecting (next attempt)
 *
 * The actual radio interaction is delegated to a {@link BluetoothRadio}
 * adapter so tests can drive deterministic outcomes; production wires the
 * adapter to `noble` lazily inside `BluetoothTransport`. Persistent state
 * (pairing keys, auto_reconnect flag) lives in the {@link BtPairingsStore}.
 *
 * Backoff schedule: 1s, 2s, 4s, 8s, 16s, capped at 30s. Resets to 1s on
 * any successful connection. Matches `noble` community best practice
 * and Zebra's TC52 reconnect window.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BluetoothPairingManager = exports.BT_BACKOFF_MS = void 0;
exports.canBtTransition = canBtTransition;
exports.nextBackoff = nextBackoff;
const VALID = {
    disconnected: ['discovering', 'connecting', 'error'],
    discovering: ['pairing', 'disconnected', 'error'],
    pairing: ['paired', 'error', 'disconnected'],
    paired: ['connecting', 'disconnected'],
    connecting: ['connected', 'reconnecting', 'error', 'disconnected'],
    connected: ['disconnected', 'reconnecting', 'error'],
    reconnecting: ['connecting', 'disconnected', 'error'],
    error: ['disconnected', 'connecting'],
};
function canBtTransition(from, to) {
    return VALID[from]?.includes(to) ?? false;
}
/** Backoff sequence (ms). Capped at the last element. */
exports.BT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
function nextBackoff(attempt) {
    const idx = Math.min(Math.max(attempt, 1) - 1, exports.BT_BACKOFF_MS.length - 1);
    return exports.BT_BACKOFF_MS[idx];
}
class BluetoothPairingManager {
    constructor(opts) {
        this.states = new Map();
        this.attempts = new Map();
        this.opts = opts;
    }
    getState(deviceId) {
        return this.states.get(deviceId) ?? 'disconnected';
    }
    listPaired() { return this.opts.store.list(); }
    /** Reconnect every auto_reconnect=1 device. Call once on app.ready. */
    async bootstrap() {
        if (!(await this.opts.radio.available()))
            return;
        for (const row of this.opts.store.list()) {
            if (row.auto_reconnect !== 1)
                continue;
            void this.connect(row.device_id).catch(() => { });
        }
    }
    async pair(opts) {
        if (!(await this.opts.radio.available())) {
            return { ok: false, error: 'bluetooth radio unavailable' };
        }
        this.transition(opts.deviceId, 'discovering', 'user initiated pair');
        this.transition(opts.deviceId, 'pairing');
        const r = await this.opts.radio.pair(opts.mac);
        if (!r.ok) {
            this.transition(opts.deviceId, 'error', r.error);
            return { ok: false, error: r.error };
        }
        this.opts.store.upsert({
            device_id: opts.deviceId,
            mac: opts.mac,
            name: opts.name ?? null,
            role: opts.role,
            link_key_plain: r.linkKey ?? null,
            auto_reconnect: opts.autoReconnect === false ? 0 : 1,
            paired_at: (this.opts.now ?? Date.now)(),
            last_connected_at: null,
        });
        this.transition(opts.deviceId, 'paired');
        return { ok: true };
    }
    async unpair(deviceId) {
        const row = this.opts.store.get(deviceId);
        if (row)
            await this.opts.radio.unpair(row.mac);
        this.opts.store.delete(deviceId);
        this.states.delete(deviceId);
        this.attempts.delete(deviceId);
        this.publish(deviceId, 'disconnected', 'unpaired');
    }
    async connect(deviceId) {
        const row = this.opts.store.get(deviceId);
        if (!row)
            return { ok: false, error: 'device not paired' };
        if (!(await this.opts.radio.available())) {
            this.transition(deviceId, 'error', 'radio unavailable');
            return { ok: false, error: 'radio unavailable' };
        }
        this.transition(deviceId, 'connecting');
        const linkKey = row.link_key_plain ?? undefined;
        const r = await this.opts.radio.connect(row.mac, linkKey);
        if (r.ok) {
            this.attempts.set(deviceId, 0);
            this.opts.store.markConnected(deviceId, (this.opts.now ?? Date.now)());
            this.transition(deviceId, 'connected');
            return { ok: true };
        }
        this.scheduleReconnect(deviceId, r.error);
        return { ok: false, error: r.error };
    }
    async disconnect(deviceId) {
        const row = this.opts.store.get(deviceId);
        if (row)
            await this.opts.radio.disconnect(row.mac);
        this.attempts.set(deviceId, 0);
        this.transition(deviceId, 'disconnected', 'manual');
    }
    async healthCheck(deviceId) {
        const row = this.opts.store.get(deviceId);
        if (!row)
            return { ok: false, latencyMs: 0, error: 'not paired', state: 'disconnected' };
        if (!(await this.opts.radio.available())) {
            return { ok: false, latencyMs: 0, error: 'radio unavailable', state: this.getState(deviceId) };
        }
        const r = await this.opts.radio.ping(row.mac);
        const state = this.getState(deviceId);
        return { ...r, state };
    }
    scheduleReconnect(deviceId, reason) {
        const attempt = (this.attempts.get(deviceId) ?? 0) + 1;
        this.attempts.set(deviceId, attempt);
        const delay = nextBackoff(attempt);
        this.transition(deviceId, 'reconnecting', `${reason ?? 'connect failed'} (attempt ${attempt}, retry in ${delay}ms)`);
        const schedule = this.opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
        schedule(() => { void this.connect(deviceId); }, delay);
    }
    transition(deviceId, to, reason) {
        const from = this.getState(deviceId);
        if (from === to)
            return;
        if (!canBtTransition(from, to)) {
            // Force disconnected → recovery path rather than throwing.
            this.states.set(deviceId, 'error');
            this.publish(deviceId, 'error', `invalid transition ${from}→${to}`);
            return;
        }
        this.states.set(deviceId, to);
        this.publish(deviceId, to, reason);
    }
    publish(deviceId, state, reason) {
        try {
            this.opts.broker?.publish({
                type: 'bluetooth:state',
                ts: (this.opts.now ?? Date.now)(),
                data: { deviceId, state, reason },
            });
        }
        catch { /* swallow */ }
    }
}
exports.BluetoothPairingManager = BluetoothPairingManager;
//# sourceMappingURL=BluetoothPairingManager.js.map