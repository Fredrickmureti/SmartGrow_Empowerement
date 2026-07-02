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

import type { DeviceAssignment } from '../DeviceManager';
import type { ExecCommand, ExecResult } from '../types';

export type DriverLifecycle =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'disconnected'
  | 'error';

export interface DriverHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** Shape every driver must implement. */
export interface IDriver {
  /** Logical role this driver instance services. */
  readonly role: DeviceAssignment['role'];

  /** Current lifecycle state. */
  state(): DriverLifecycle;

  /** Establish device readiness (open USB claim, TCP test, etc). Idempotent. */
  connect(): Promise<void>;

  /** Release transport handles. Idempotent and safe to call repeatedly. */
  disconnect(): Promise<void>;

  /** Non-destructive liveness probe. Never prints / kicks / writes data. */
  healthCheck(): Promise<DriverHealth>;

  /** Execute a `role:op` command. Driver decides which ops it supports. */
  handle(cmd: ExecCommand): Promise<ExecResult>;

  /** Op-names this driver accepts, used by DeviceManager for router registration. */
  supportedOps(): readonly string[];
}

/** Base helper — uniform state-management for derived classes. */
export abstract class BaseDriver implements IDriver {
  abstract readonly role: DeviceAssignment['role'];
  protected _state: DriverLifecycle = 'idle';

  state(): DriverLifecycle { return this._state; }

  async connect(): Promise<void> {
    this._state = 'connecting';
    try {
      await this.onConnect();
      this._state = 'connected';
    } catch (err) {
      this._state = 'error';
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    try { await this.onDisconnect(); } finally { this._state = 'disconnected'; }
  }

  async healthCheck(): Promise<DriverHealth> {
    const t0 = Date.now();
    try {
      const r = await this.onHealthCheck();
      if (!r.ok && this._state === 'connected') this._state = 'degraded';
      if (r.ok && (this._state === 'degraded' || this._state === 'disconnected')) this._state = 'connected';
      return { ...r, latencyMs: r.latencyMs ?? Date.now() - t0 };
    } catch (err) {
      this._state = 'degraded';
      return { ok: false, latencyMs: Date.now() - t0, error: (err as Error).message };
    }
  }

  abstract handle(cmd: ExecCommand): Promise<ExecResult>;
  abstract supportedOps(): readonly string[];

  protected async onConnect(): Promise<void> { /* default no-op */ }
  protected async onDisconnect(): Promise<void> { /* default no-op */ }
  protected abstract onHealthCheck(): Promise<DriverHealth>;
}
