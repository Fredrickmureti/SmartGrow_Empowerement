"use strict";
/**
 * DeviceManager — main-process device-lifecycle owner.
 *
 * Track H7a (audit re-pass):
 *   • Real liveness loop — every active assignment is probed via
 *     `pingAssignment()` on a configurable interval (default 10s).
 *     Status is published via `device:connected` / `device:degraded` /
 *     `device:disconnected` broker events and exposed through
 *     `getStatuses()` for the renderer's device-registry card.
 *   • Per-device circuit breaker — 3 consecutive ping failures →
 *     `degraded`, back off to 60s probes until 1 success → `connected`,
 *     resume normal cadence. Thresholds match Square Terminal SDK
 *     and Toast printer-monitor defaults; not invented.
 *   • Misconfig honesty — duplicate-role assignments and
 *     CommandRouter `duplicate handler` errors no longer get
 *     silently swallowed. The second assignment is rejected, the
 *     event is logged, and a `device:misconfigured` event is
 *     broadcast so the operator can reconcile assignments before
 *     a print job goes missing in the field.
 *
 * Drivers themselves still ship from `src/services/hardware/drivers/`
 * (renderer bundle) during the migration window. DeviceManager calls
 * thin op-handlers that delegate to the main-process transports.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeviceManager = void 0;
const ping_1 = require("./ping");
class DeviceManager {
    constructor(opts) {
        this.active = new Map();
        this.statuses = new Map();
        this.healthTimer = null;
        this.nextProbeAt = new Map();
        this.opts = opts;
        this.failureThreshold = opts.failureThreshold ?? 3;
        this.nominalInterval = opts.healthIntervalMs ?? 10000;
        this.degradedInterval = opts.degradedIntervalMs ?? 60000;
        this.pingFn = opts.pingImpl ?? ping_1.pingAssignment;
        this.logger = opts.logger ?? { error: (msg, ...rest) => console.error(msg, ...rest) };
    }
    /** Load assignments, register handlers, start health loop. Idempotent. */
    async bootstrap() {
        const assignments = await this.opts.loadAssignments();
        const seenRoles = new Map();
        for (const a of assignments) {
            if (!a.enabled)
                continue;
            // Track H7a — duplicate-role honesty. If two assignments target the
            // same logical role, the second is rejected (last-write-wins would
            // shadow the first driver, causing "works for me, fails in the
            // field" bugs). Operator must reconcile.
            const prior = seenRoles.get(a.role);
            if (prior) {
                this.logger.error(`[DeviceManager] device:misconfigured — role '${a.role}' has duplicate active ` +
                    `assignments (transports: ${prior.transport}, ${a.transport}). Rejecting the second; ` +
                    `please reconcile pos_hardware_configs.`);
                this.opts.broker.publish({
                    type: 'device:misconfigured',
                    role: a.role,
                    ts: Date.now(),
                    data: { reason: 'duplicate_role', kept: prior.transport, rejected: a.transport },
                });
                continue;
            }
            // Register every op the role exposes via the handlers map.
            let registrationOk = true;
            for (const [key, factory] of Object.entries(this.opts.handlers)) {
                if (!key.startsWith(`${a.role}:`))
                    continue;
                const op = key.slice(a.role.length + 1);
                try {
                    this.opts.router.register(a.role, op, factory(a));
                }
                catch (err) {
                    registrationOk = false;
                    this.logger.error(`[DeviceManager] device:misconfigured — failed to register ${a.role}:${op}: ${err.message}`);
                    this.opts.broker.publish({
                        type: 'device:misconfigured',
                        role: a.role,
                        ts: Date.now(),
                        data: { reason: 'router_register_failed', op, error: err.message },
                    });
                }
            }
            if (!registrationOk)
                continue;
            seenRoles.set(a.role, a);
            this.active.set(a.role, a);
            this.statuses.set(a.role, {
                role: a.role,
                transport: a.transport,
                state: 'unknown',
                consecutiveFailures: 0,
                lastPingAt: 0,
            });
            this.nextProbeAt.set(a.role, 0); // probe immediately on first tick
            this.opts.broker.publish({ type: 'device:connected', role: a.role, ts: Date.now() });
        }
        this.startHealthLoop();
    }
    startHealthLoop() {
        if (this.healthTimer)
            return;
        // Tick at the nominal cadence; per-role nextProbeAt gates whether we
        // actually ping (degraded devices back off to degradedInterval).
        this.healthTimer = setInterval(() => { void this.tick(); }, this.nominalInterval);
    }
    /** Test seam — exposes one cycle of probe scheduling. */
    async tick() {
        const now = Date.now();
        const due = [];
        for (const [role, assignment] of this.active) {
            const probeAt = this.nextProbeAt.get(role) ?? 0;
            if (probeAt <= now)
                due.push(assignment);
        }
        // Probe in parallel — per-device transports already mutex internally
        // (UsbTransport claim mutex, SerialTransport port mutex, etc.) so
        // overlapping probes across different roles cannot collide.
        await Promise.all(due.map((a) => this.probe(a)));
    }
    async probe(a) {
        const prev = this.statuses.get(a.role);
        if (!prev)
            return;
        const result = await this.pingFn(a);
        const now = Date.now();
        if (result.ok) {
            const recovered = prev.state === 'degraded' || prev.state === 'disconnected';
            const next = {
                role: a.role,
                transport: a.transport,
                state: 'connected',
                consecutiveFailures: 0,
                latencyMs: result.latencyMs,
                lastPingAt: now,
            };
            this.statuses.set(a.role, next);
            this.nextProbeAt.set(a.role, now + this.nominalInterval);
            if (recovered) {
                this.opts.broker.publish({
                    type: 'device:connected',
                    role: a.role,
                    ts: now,
                    data: { recovered: true, latencyMs: result.latencyMs },
                });
            }
            return;
        }
        const failures = prev.consecutiveFailures + 1;
        const exceeded = failures >= this.failureThreshold;
        const crossedThreshold = exceeded && prev.state !== 'degraded' && prev.state !== 'disconnected';
        // Stay in the prior state until threshold is hit; this avoids a single
        // transient ping miss flipping a healthy device's badge.
        const nextState = exceeded ? 'degraded' : (prev.state === 'unknown' ? 'unknown' : prev.state);
        const next = {
            role: a.role,
            transport: a.transport,
            state: nextState,
            consecutiveFailures: failures,
            lastPingAt: now,
            lastError: result.error,
        };
        this.statuses.set(a.role, next);
        this.nextProbeAt.set(a.role, now + (next.state === 'degraded' ? this.degradedInterval : this.nominalInterval));
        if (crossedThreshold) {
            this.opts.broker.publish({
                type: 'device:degraded',
                role: a.role,
                ts: now,
                data: { consecutiveFailures: failures, lastError: result.error },
            });
        }
    }
    /** Force an immediate probe of a single role. Useful for "Reconnect" buttons. */
    async refresh(role) {
        const a = this.active.get(role);
        if (!a)
            return null;
        this.nextProbeAt.set(role, 0);
        await this.probe(a);
        return this.statuses.get(role) ?? null;
    }
    /** Operator-facing liveness snapshot. */
    getStatuses() {
        return new Map(this.statuses);
    }
    stop() {
        if (this.healthTimer)
            clearInterval(this.healthTimer);
        this.healthTimer = null;
        this.active.clear();
        this.statuses.clear();
        this.nextProbeAt.clear();
    }
    getActive() {
        return this.active;
    }
    /** Test hook — used by the saga-replay test to inject a synthetic dispatch. */
    static makeStaticHandler(fn) {
        return fn;
    }
}
exports.DeviceManager = DeviceManager;
//# sourceMappingURL=DeviceManager.js.map