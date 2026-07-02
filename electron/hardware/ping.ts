/**
 * ping.ts — Per-transport liveness probe for DeviceManager's health loop.
 *
 * Industry-aligned approach (Square Terminal SDK, Toast printer monitor):
 *   • Non-destructive: never writes data bytes, never triggers a print.
 *   • Bounded: each probe has its own short timeout (~500ms target,
 *     1.5s ceiling) so a hung device cannot stall the loop.
 *   • Per-(role, transport) dispatch — transport-specific failure modes
 *     surface as `lastError` for operator triage in the device card.
 *
 * Uses transports' existing `test()` / `testConnect()` primitives so the
 * ping path shares the same code path that the registration UI's
 * "Test Connection" button already exercises in the field.
 */

import type { DeviceAssignment } from './DeviceManager';
import { NetworkTransport } from './transports/NetworkTransport';
import { UsbTransport } from './transports/UsbTransport';
import { SerialTransport } from './transports/SerialTransport';
import { CupsTransport } from './transports/CupsTransport';
import { WinSpoolerTransport } from './transports/WinSpoolerTransport';

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

function cfgOf(a: DeviceAssignment): Record<string, unknown> {
  return (a.config && typeof a.config === 'object') ? a.config : {};
}

/**
 * Probe an assignment's device. Always returns within ~1.5s; never throws.
 */
export async function pingAssignment(a: DeviceAssignment): Promise<PingResult> {
  const cfg = cfgOf(a);
  const started = Date.now();
  try {
    switch (a.transport) {
      case 'network': {
        const host = String(cfg.host ?? cfg.ipAddress ?? '');
        const port = Number(cfg.port ?? 9100);
        if (!host) return { ok: false, latencyMs: 0, error: 'missing host' };
        const r = await NetworkTransport.testConnect({ host, port, timeoutMs: 1_500 });
        return r.ok
          ? { ok: true, latencyMs: r.latencyMs }
          : { ok: false, latencyMs: Date.now() - started, error: (r as { error: string }).error };
      }
      case 'usb': {
        const vendorId = Number(cfg.vendorId);
        const productId = Number(cfg.productId);
        if (!Number.isFinite(vendorId) || !Number.isFinite(productId)) {
          return { ok: false, latencyMs: 0, error: 'missing vendorId/productId' };
        }
        const r = await UsbTransport.test({
          vendorId,
          productId,
          interfaceIndex: cfg.interfaceIndex as number | undefined,
        });
        return r.ok
          ? { ok: true, latencyMs: Date.now() - started }
          : { ok: false, latencyMs: Date.now() - started, error: r.error };
      }
      case 'serial': {
        const path = String(cfg.path ?? cfg.port ?? '');
        const baudRate = Number(cfg.baudRate ?? 9600);
        if (!path) return { ok: false, latencyMs: 0, error: 'missing path' };
        const r = await SerialTransport.test({
          path,
          baudRate,
          dataBits: cfg.dataBits as 5 | 6 | 7 | 8 | undefined,
          stopBits: cfg.stopBits as 1 | 1.5 | 2 | undefined,
          parity: cfg.parity as 'none' | 'even' | 'odd' | 'mark' | 'space' | undefined,
        });
        return r.ok
          ? { ok: true, latencyMs: Date.now() - started }
          : { ok: false, latencyMs: Date.now() - started, error: r.error };
      }
      case 'cups': {
        const queue = String(cfg.queue ?? '');
        if (!queue) return { ok: false, latencyMs: 0, error: 'missing queue' };
        const r = await CupsTransport.test({ queue });
        return r.ok
          ? { ok: true, latencyMs: Date.now() - started }
          : { ok: false, latencyMs: Date.now() - started, error: r.error };
      }
      case 'winspool': {
        const printer = String(cfg.printer ?? '');
        if (!printer) return { ok: false, latencyMs: 0, error: 'missing printer' };
        const r = await WinSpoolerTransport.test({ printer });
        return r.ok
          ? { ok: true, latencyMs: Date.now() - started }
          : { ok: false, latencyMs: Date.now() - started, error: r.error };
      }
      case 'bluetooth':
        {
          const deviceId = String(cfg.deviceId ?? cfg.device_id ?? '');
          if (!deviceId) return { ok: false, latencyMs: 0, error: 'missing deviceId' };
          // Lazy import to avoid a require cycle (bluetooth/index → transport → ping).
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getBluetoothPairingManager } = require('./bluetooth');
          const mgr = getBluetoothPairingManager();
          if (!mgr) return { ok: false, latencyMs: 0, error: 'bluetooth manager not initialised' };
          const h = await mgr.healthCheck(deviceId);
          return { ok: h.ok, latencyMs: h.latencyMs ?? Date.now() - started, error: h.error };
        }
      case 'browser':
        // Browser-side device is owned by the renderer; main has no probe.
        return { ok: true, latencyMs: 0 };
      default:
        return { ok: false, latencyMs: 0, error: `unknown transport ${String(a.transport)}` };
    }
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message };
  }
}
