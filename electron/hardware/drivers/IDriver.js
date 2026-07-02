"use strict";
/**
 * IDriver — main-process driver contract (ADR-0014 Track D).
 *
 * Every hardware driver in `electron/hardware/drivers/` implements this
 * interface. DeviceManager owns one driver instance per active
 * assignment, calls `connect()` on bootstrap, dispatches `handle(op, …)`
 * through CommandRouter, and polls `healthCheck()` on the ping loop.
 *
 * Drivers MUST NOT import `node-usb` / `serialport` at module scope —
 * always lazy-require inside method bodies — so the renderer test
 * harness (jsdom) can instantiate them with a mock transport.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseDriver = void 0;
/** Base helper — uniform state-management for derived classes. */
class BaseDriver {
    constructor() {
        this._state = 'idle';
    }
    state() { return this._state; }
    async connect() {
        this._state = 'connecting';
        try {
            await this.onConnect();
            this._state = 'connected';
        }
        catch (err) {
            this._state = 'error';
            throw err;
        }
    }
    async disconnect() {
        try {
            await this.onDisconnect();
        }
        finally {
            this._state = 'disconnected';
        }
    }
    async healthCheck() {
        const t0 = Date.now();
        try {
            const r = await this.onHealthCheck();
            if (!r.ok && this._state === 'connected')
                this._state = 'degraded';
            if (r.ok && (this._state === 'degraded' || this._state === 'disconnected'))
                this._state = 'connected';
            return { ...r, latencyMs: r.latencyMs ?? Date.now() - t0 };
        }
        catch (err) {
            this._state = 'degraded';
            return { ok: false, latencyMs: Date.now() - t0, error: err.message };
        }
    }
    async onConnect() { }
    async onDisconnect() { }
}
exports.BaseDriver = BaseDriver;
//# sourceMappingURL=IDriver.js.map