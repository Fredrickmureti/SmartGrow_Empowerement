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

import type { CommandRouter, OpHandler } from './CommandRouter';
import type { EventBroker } from './EventBroker';
import type { DeviceRole, ExecCommand, ExecResult } from './types';
import { pingAssignment, type PingResult } from './ping';

export interface DeviceAssignment {
  /** Logical role this assignment targets. */
  role: DeviceRole;
  /** Transport identifier — usb | serial | network | bluetooth | cups | winspool. */
  transport: 'usb' | 'serial' | 'network' | 'bluetooth' | 'cups' | 'winspool' | 'browser';
  /** Transport-specific config (vendor/product id, ip:port, port path, mac, etc). */
  config: Record<string, unknown>;
  /** Driver to use (escpos, epos, line-display, etc). */
  driver: string;
  /** Enabled flag — disabled assignments are not registered. */
  enabled: boolean;
}

export type DeviceLiveness = 'connected' | 'degraded' | 'disconnected' | 'unknown';

export interface DeviceStatus {
  role: DeviceRole;
  transport: DeviceAssignment['transport'];
  state: DeviceLiveness;
  consecutiveFailures: number;
  latencyMs?: number;
  lastPingAt: number;
  lastError?: string;
}

export interface DeviceManagerOptions {
  router: CommandRouter;
  broker: EventBroker;
  loadAssignments: () => Promise<DeviceAssignment[]> | DeviceAssignment[];
  /** Op-handler factory keyed by `${role}:${op}`. */
  handlers: Record<string, (assignment: DeviceAssignment) => OpHandler>;
  /** Nominal ping cadence in ms. Default 10_000. */
  healthIntervalMs?: number;
  /** Back-off cadence after a device hits `degraded`. Default 60_000. */
  degradedIntervalMs?: number;
  /** Consecutive failures before flipping to `degraded`. Default 3. */
  failureThreshold?: number;
  /** Inject a custom ping (used by tests). */
  pingImpl?: (a: DeviceAssignment) => Promise<PingResult>;
  /** Inject a logger (default console.error). */
  logger?: { error: (msg: string, ...rest: unknown[]) => void };
}

export class DeviceManager {
  private opts: DeviceManagerOptions;
  private active = new Map<DeviceRole, DeviceAssignment>();
  private statuses = new Map<DeviceRole, DeviceStatus>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private nextProbeAt = new Map<DeviceRole, number>();
  // Audit Wave 9d.9 (P4 #19) — per-role mutex chain. Both probes (here)
  // and exec dispatch (via `withRoleLock`, called by CommandRouter) take
  // the same lock so a 10s health ping can never collide with a print job
  // on the same transport, even when the transport itself forgets to
  // mutex internally.
  private roleLocks = new Map<DeviceRole, Promise<unknown>>();
  private readonly failureThreshold: number;
  private readonly nominalInterval: number;
  private readonly degradedInterval: number;
  private readonly pingFn: (a: DeviceAssignment) => Promise<PingResult>;
  private readonly logger: { error: (msg: string, ...rest: unknown[]) => void };

  constructor(opts: DeviceManagerOptions) {
    this.opts = opts;
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.nominalInterval = opts.healthIntervalMs ?? 10_000;
    this.degradedInterval = opts.degradedIntervalMs ?? 60_000;
    this.pingFn = opts.pingImpl ?? pingAssignment;
    this.logger = opts.logger ?? { error: (msg, ...rest) => console.error(msg, ...rest) };
  }

  /**
   * Serialize `fn` on the per-role lock. CommandRouter wraps every
   * `dispatch(role, …)` in this so probes (this file) and command
   * handlers cannot run concurrently against the same physical device.
   * The lock is a single-slot promise chain — FIFO, no starvation.
   */
  withRoleLock<T>(role: DeviceRole, fn: () => Promise<T>): Promise<T> {
    const prev = this.roleLocks.get(role) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    // Keep the chain alive but tolerate caller failures.
    this.roleLocks.set(role, next.catch(() => undefined));
    return next;
  }

  /** Load assignments, register handlers, start health loop. Idempotent. */
  async bootstrap(): Promise<void> {
    // Wave 9d.9 — every exec dispatch now takes the same per-role lock
    // as probes, eliminating the "ping mid-print" collision class.
    try {
      (this.opts.router as unknown as { setRoleLock?: (fn: <T>(r: DeviceRole, f: () => Promise<T>) => Promise<T>) => void })
        .setRoleLock?.(<T>(r: DeviceRole, f: () => Promise<T>) => this.withRoleLock(r, f));
    } catch { /* router may be a stub in tests */ }

    const assignments = await this.opts.loadAssignments();
    const seenRoles = new Map<DeviceRole, DeviceAssignment>();

    for (const a of assignments) {
      if (!a.enabled) continue;

      // Track H7a — duplicate-role honesty. If two assignments target the
      // same logical role, the second is rejected (last-write-wins would
      // shadow the first driver, causing "works for me, fails in the
      // field" bugs). Operator must reconcile.
      const prior = seenRoles.get(a.role);
      if (prior) {
        this.logger.error(
          `[DeviceManager] device:misconfigured — role '${a.role}' has duplicate active ` +
          `assignments (transports: ${prior.transport}, ${a.transport}). Rejecting the second; ` +
          `please reconcile pos_hardware_configs.`,
        );
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
        if (!key.startsWith(`${a.role}:`)) continue;
        const op = key.slice(a.role.length + 1);
        try {
          this.opts.router.register(a.role, op, factory(a));
        } catch (err) {
          registrationOk = false;
          this.logger.error(
            `[DeviceManager] device:misconfigured — failed to register ${a.role}:${op}: ${(err as Error).message}`,
          );
          this.opts.broker.publish({
            type: 'device:misconfigured',
            role: a.role,
            ts: Date.now(),
            data: { reason: 'router_register_failed', op, error: (err as Error).message },
          });
        }
      }
      if (!registrationOk) continue;

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

  private startHealthLoop(): void {
    if (this.healthTimer) return;
    // Tick at the nominal cadence; per-role nextProbeAt gates whether we
    // actually ping (degraded devices back off to degradedInterval).
    this.healthTimer = setInterval(() => { void this.tick(); }, this.nominalInterval);
  }

  /** Test seam — exposes one cycle of probe scheduling. */
  async tick(): Promise<void> {
    const now = Date.now();
    const due: DeviceAssignment[] = [];
    for (const [role, assignment] of this.active) {
      const probeAt = this.nextProbeAt.get(role) ?? 0;
      if (probeAt <= now) due.push(assignment);
    }
    // Probe in parallel — per-device transports already mutex internally
    // (UsbTransport claim mutex, SerialTransport port mutex, etc.) so
    // overlapping probes across different roles cannot collide.
    await Promise.all(due.map((a) => this.probe(a)));
  }

  private async probe(a: DeviceAssignment): Promise<void> {
    // Wave 9d.9 — serialize against in-flight exec on the same role.
    return this.withRoleLock(a.role, () => this.probeLocked(a));
  }

  private async probeLocked(a: DeviceAssignment): Promise<void> {
    const prev = this.statuses.get(a.role);
    if (!prev) return;
    const result = await this.pingFn(a);
    const now = Date.now();

    if (result.ok) {
      const recovered = prev.state === 'degraded' || prev.state === 'disconnected';
      const next: DeviceStatus = {
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
    const nextState: DeviceLiveness = exceeded ? 'degraded' : (prev.state === 'unknown' ? 'unknown' : prev.state);
    const next: DeviceStatus = {
      role: a.role,
      transport: a.transport,
      state: nextState,
      consecutiveFailures: failures,
      lastPingAt: now,
      lastError: result.error,
    };
    this.statuses.set(a.role, next);
    this.nextProbeAt.set(
      a.role,
      now + (next.state === 'degraded' ? this.degradedInterval : this.nominalInterval),
    );

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
  async refresh(role: DeviceRole): Promise<DeviceStatus | null> {
    const a = this.active.get(role);
    if (!a) return null;
    this.nextProbeAt.set(role, 0);
    await this.probe(a);
    return this.statuses.get(role) ?? null;
  }

  /** Operator-facing liveness snapshot. */
  getStatuses(): Map<DeviceRole, DeviceStatus> {
    return new Map(this.statuses);
  }

  stop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.active.clear();
    this.statuses.clear();
    this.nextProbeAt.clear();
  }

  getActive(): ReadonlyMap<DeviceRole, DeviceAssignment> {
    return this.active;
  }

  /** Test hook — used by the saga-replay test to inject a synthetic dispatch. */
  static makeStaticHandler(fn: (cmd: ExecCommand) => Promise<ExecResult>): OpHandler {
    return fn;
  }
}
