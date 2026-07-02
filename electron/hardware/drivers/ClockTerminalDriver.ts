/**
 * ClockTerminalDriver — main-process driver for attendance/biometric
 * clock terminals (ZKTeco, Hikvision, Suprema, RFID kiosks, generic).
 *
 * Wave B3.1: this driver exists so `buildDriver()` no longer returns
 * `null` for `clock_terminal` / `biometric_reader` roles. The renderer
 * + DeviceManager can now register the assignment, run the liveness
 * loop, and surface state transitions through the same status pipeline
 * as receipt/label printers.
 *
 * Scope:
 *   - Liveness via a TCP reachability probe against `config.address`
 *     (or `config.host:port`). Biometric vendors do not expose a
 *     standard health-check op; a successful TCP connect is the most
 *     reliable signal we can produce without per-vendor SDKs.
 *   - The actual punch ingestion is OWNED by the `biometric-ingest`
 *     edge function — terminals push events to our HTTPS endpoint with
 *     their HMAC secret. This driver does NOT poll for punches; it
 *     only reports whether the device is reachable so HR dashboards
 *     can flag offline terminals.
 *   - Per-vendor command dispatch (enroll user, sync clock, push roster)
 *     is deferred to Wave B7 (vendor SDK). Until then `handle()` returns
 *     `{ ok:false, error:'unsupported op' }` so callers fail loudly.
 */

import { BaseDriver, type DriverHealth } from './IDriver';
import type { DeviceAssignment } from '../DeviceManager';
import type { ExecCommand, ExecResult } from '../types';

interface ClockTerminalConfig {
  address?: string;
  host?: string;
  port?: number;
  timeout_ms?: number;
}

const DEFAULT_TIMEOUT_MS = 2500;

export class ClockTerminalDriver extends BaseDriver {
  readonly role: DeviceAssignment['role'];

  constructor(private readonly assignment: DeviceAssignment) {
    super();
    this.role = assignment.role;
  }

  supportedOps(): readonly string[] {
    // No outbound ops yet — terminals are push-only (HTTPS → biometric-ingest).
    // Wave B7 will add enroll / sync_clock / push_roster.
    return [];
  }

  protected async onHealthCheck(): Promise<DriverHealth> {
    const cfg = (this.assignment.config ?? {}) as ClockTerminalConfig;
    const { host, port } = this.resolveTarget(cfg);
    if (!host || !port) {
      return { ok: false, latencyMs: 0, error: 'no network address configured' };
    }
    const t0 = Date.now();
    try {
      // Lazy-require: keep node-only modules out of renderer test bundles.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const net = require('net') as typeof import('net');
      await new Promise<void>((resolve, reject) => {
        const sock = new net.Socket();
        const timer = setTimeout(() => {
          sock.destroy();
          reject(new Error('timeout'));
        }, cfg.timeout_ms ?? DEFAULT_TIMEOUT_MS);
        sock.once('connect', () => {
          clearTimeout(timer);
          sock.end();
          resolve();
        });
        sock.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        sock.connect(port, host);
      });
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, error: (err as Error).message };
    }
  }

  async handle(cmd: ExecCommand): Promise<ExecResult> {
    // No outbound ops until vendor SDK (B7). Fail loudly so callers don't
    // silently queue commands that will never execute.
    return {
      ok: false,
      error: `unsupported op '${cmd.op}' for clock_terminal (vendor SDK pending — Wave B7)`,
    };
  }

  private resolveTarget(cfg: ClockTerminalConfig): { host?: string; port?: number } {
    if (cfg.host && cfg.port) return { host: cfg.host, port: cfg.port };
    if (cfg.address) {
      // Accept "host:port" or bare "host" (defaults to 4370, ZKTeco SDK port).
      const [h, p] = cfg.address.split(':');
      return { host: h, port: p ? Number(p) : 4370 };
    }
    return {};
  }
}
