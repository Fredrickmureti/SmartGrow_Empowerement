/**
 * TransportDriver — shared byte-stream dispatch for drivers that just push
 * ESC/POS (or any opaque byte stream) over a configured transport.
 *
 * Consolidates the `sendBytes()` switch that previously lived in
 * `handlers/index.ts`. Receipt / kitchen / cash-drawer / customer-display
 * drivers all derive from this; they differ only in the bytes they build
 * and the ops they advertise.
 */

import type { DeviceAssignment } from '../DeviceManager';
import type { ExecResult, DeviceRole } from '../types';
import type { DriverHealth, IDriver, DriverLifecycle } from './IDriver';
import { BaseDriver } from './IDriver';
import { NetworkTransport } from '../transports/NetworkTransport';
import { UsbTransport } from '../transports/UsbTransport';
import { SerialTransport } from '../transports/SerialTransport';
import { CupsTransport } from '../transports/CupsTransport';
import { WinSpoolerTransport } from '../transports/WinSpoolerTransport';

export abstract class TransportDriver extends BaseDriver implements IDriver {
  abstract readonly role: DeviceRole;

  constructor(protected readonly assignment: DeviceAssignment) {
    super();
  }

  protected cfg(): Record<string, unknown> {
    return (this.assignment.config && typeof this.assignment.config === 'object')
      ? this.assignment.config
      : {};
  }

  /** Push raw bytes through the assignment's transport. */
  protected async send(bytes: Buffer): Promise<ExecResult> {
    const a = this.assignment;
    const cfg = this.cfg();
    switch (a.transport) {
      case 'network': {
        const host = String(cfg.host ?? cfg.ipAddress ?? '');
        const port = Number(cfg.port ?? 9100);
        if (!host) return { ok: false, error: 'network transport missing host' };
        const r = await NetworkTransport.rawSend(
          { host, port, timeoutMs: Number(cfg.timeoutMs ?? 5000) },
          bytes,
        );
        return r.ok
          ? { ok: true, result: { bytes: r.bytes, transport: 'network' } }
          : { ok: false, error: (r as { error: string }).error };
      }
      case 'usb': {
        const vendorId = Number(cfg.vendorId);
        const productId = Number(cfg.productId);
        if (!Number.isFinite(vendorId) || !Number.isFinite(productId)) {
          return { ok: false, error: 'usb transport missing vendorId/productId' };
        }
        const r = await UsbTransport.send(
          { vendorId, productId, interfaceIndex: cfg.interfaceIndex as number | undefined, timeoutMs: cfg.timeoutMs as number | undefined },
          bytes,
        );
        return r.ok
          ? { ok: true, result: { bytes: r.bytes, transport: 'usb' } }
          : { ok: false, error: r.error ?? 'usb send failed' };
      }
      case 'serial': {
        const path = String(cfg.path ?? cfg.port ?? '');
        const baudRate = Number(cfg.baudRate ?? 9600);
        if (!path) return { ok: false, error: 'serial transport missing path' };
        const r = await SerialTransport.send(
          {
            path, baudRate,
            dataBits: cfg.dataBits as 5 | 6 | 7 | 8 | undefined,
            stopBits: cfg.stopBits as 1 | 1.5 | 2 | undefined,
            parity: cfg.parity as 'none' | 'even' | 'odd' | 'mark' | 'space' | undefined,
            idleCloseMs: cfg.idleCloseMs as number | undefined,
          },
          bytes,
        );
        return r.ok
          ? { ok: true, result: { bytes: r.bytes, transport: 'serial' } }
          : { ok: false, error: r.error ?? 'serial send failed' };
      }
      case 'cups': {
        const queue = String(cfg.queue ?? '');
        if (!queue) return { ok: false, error: 'cups transport missing queue' };
        const r = await CupsTransport.send({ queue, timeoutMs: cfg.timeoutMs as number | undefined }, bytes);
        return r.ok ? { ok: true, result: { bytes: r.bytes, transport: 'cups' } } : { ok: false, error: r.error ?? 'cups send failed' };
      }
      case 'winspool': {
        const printer = String(cfg.printer ?? '');
        if (!printer) return { ok: false, error: 'winspool transport missing printer' };
        const r = await WinSpoolerTransport.send({ printer, timeoutMs: cfg.timeoutMs as number | undefined }, bytes);
        return r.ok ? { ok: true, result: { bytes: r.bytes, transport: 'winspool' } } : { ok: false, error: r.error ?? 'winspool send failed' };
      }
      case 'bluetooth': {
        // Lazy-import so the renderer test harness doesn't pull `noble`.
        const { BluetoothTransport } = await import('../transports/BluetoothTransport');
        const r = await BluetoothTransport.send(
          { deviceId: String(cfg.deviceId ?? cfg.mac ?? ''), serviceUuid: cfg.serviceUuid as string | undefined, characteristicUuid: cfg.characteristicUuid as string | undefined },
          bytes,
        );
        return r.ok ? { ok: true, result: { bytes: r.bytes, transport: 'bluetooth' } } : { ok: false, error: r.error ?? 'bluetooth send failed' };
      }
      case 'browser':
        return { ok: false, error: 'browser transport is renderer-side; main process must not dispatch it' };
      default:
        return { ok: false, error: `transport '${(a as { transport: string }).transport}' is unsupported` };
    }
  }

  /** Default ping uses the existing `ping.ts` helpers via dynamic import to avoid cycle. */
  protected async onHealthCheck(): Promise<DriverHealth> {
    const { pingAssignment } = await import('../ping');
    const r = await pingAssignment(this.assignment);
    return { ok: r.ok, latencyMs: r.latencyMs, error: r.error };
  }

  // BaseDriver expects state(); inherits implementation.
  override state(): DriverLifecycle { return this._state; }
}
