/**
 * BrowserHardwareAdapter — renderer-side hardware runtime.
 *
 * ADR-0014 Track 4b.5 — When the POS is running outside Electron (browser
 * preview, mobile-web POS, dev mode without `window.pos.hardware.exec`),
 * this adapter is the **sole** owner of:
 *   - the device registry (role → device → driver)
 *   - driver lifecycle (connect / disconnect / health-check / reconnect)
 *   - command dispatch via the same `(role, op, payload)` contract the
 *     Electron main-process CommandRouter validates.
 *
 * Replaces the legacy `HardwareProxy` singleton. The architectural shift:
 * `HardwareClient` (the single chokepoint every POS UI imports) no longer
 * imports a legacy renderer-side proxy. It now picks between two adapters
 * with identical surfaces — `window.pos.hardware.exec` in Electron, this
 * adapter in the browser. This is the same dual-adapter pattern Shopify
 * POS and Lightspeed use (native bridge + WebUSB fallback).
 *
 * IMPORTANT: this file is renderer-only. The Electron main process owns
 * its own driver runtime in `electron/hardware/`; there is intentionally
 * no shared driver code across the boundary.
 */

import type { DeviceRole, DriverCommand, DriverResult, IDriver } from './drivers/DriverInterface';
import { createDriver } from './drivers/DriverRegistry';
import type { DriverType } from './drivers/DriverInterface';
import { hardwareEventBus } from './HardwareEventBus';
import { mediaDots } from '@/services/printing/mediaGeometry';

/**
 * ADR-0087 — mirror of the main-process ZPL envelope logic. Strip any
 * `^PW`/`^LL` present in the body and re-emit them from the resolved
 * media so the browser fallback path scales content the same way the
 * Electron/LAN-agent paths do.
 */
function injectZplEnvelope(
  zpl: string,
  p: { mediaWidthMm?: number; mediaHeightMm?: number; dpi?: number },
): string {
  const w = Number(p.mediaWidthMm);
  const h = Number(p.mediaHeightMm);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return zpl;
  const { widthDots, heightDots } = mediaDots({ widthMm: w, heightMm: h, dpi: Number(p.dpi) || 203 });
  const stripped = zpl.replace(/\^PW\d+/g, '').replace(/\^LL\d+/g, '');
  const head = stripped.indexOf('^XA');
  if (head < 0) return `^XA\n^PW${widthDots}\n^LL${heightDots ?? widthDots}\n${stripped}\n^XZ`;
  const before = stripped.slice(0, head + 3);
  const after = stripped.slice(head + 3);
  return `${before}\n^PW${widthDots}\n^LL${heightDots ?? widthDots}${after.startsWith('\n') ? '' : '\n'}${after}`;
}

function injectEplEnvelope(
  epl: string,
  p: { mediaWidthMm?: number; mediaHeightMm?: number; dpi?: number },
): string {
  const w = Number(p.mediaWidthMm);
  const h = Number(p.mediaHeightMm);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return epl;
  const { widthDots, heightDots } = mediaDots({ widthMm: w, heightMm: h, dpi: Number(p.dpi) || 203 });
  const stripped = epl
    .replace(/^\s*q\d+\s*\r?\n/gm, '')
    .replace(/^\s*Q\d+,\d+(?:\+\d+)?\s*\r?\n/gm, '');
  return `q${widthDots}\r\nQ${heightDots ?? widthDots},24\r\n${stripped}`;
}

export interface DeviceAssignment {
  id: string;
  deviceRole: DeviceRole;
  driverType: DriverType;
  connectionParams: Record<string, unknown>;
  displayName: string;
  isActive: boolean;
}

/**
 * The `(role, op, payload)` envelope mirrors `electron/hardware/types.ts:ExecCommand`
 * so the Electron and browser code paths are behaviorally identical.
 */
export interface ExecCommandInput {
  role: DeviceRole;
  op: string;
  payload?: unknown;
  idempotencyKey?: string;
  maxAttempts?: number;
}

class BrowserHardwareAdapterService {
  private activeDrivers = new Map<string, IDriver>();
  private roleAssignments = new Map<DeviceRole, string>();
  private devices = new Map<string, DeviceAssignment>();

  /** Load device assignments for the active register. */
  loadDevices(assignments: DeviceAssignment[]): void {
    this.devices.clear();
    this.roleAssignments.clear();
    for (const device of assignments) {
      if (!device.isActive) continue;
      this.devices.set(device.id, device);
      if (!this.roleAssignments.has(device.deviceRole)) {
        this.roleAssignments.set(device.deviceRole, device.id);
      }
    }
    console.log('[BrowserHardwareAdapter] Loaded devices:', {
      total: assignments.length,
      active: this.devices.size,
      roles: Object.fromEntries(this.roleAssignments),
    });
  }

  async connectAll(): Promise<Map<string, DriverResult>> {
    const results = new Map<string, DriverResult>();
    for (const [id, device] of this.devices) {
      results.set(id, await this.connectDevice(id, device));
    }
    return results;
  }

  private async connectDevice(id: string, device: DeviceAssignment): Promise<DriverResult> {
    try {
      const driver = createDriver(device.driverType);
      if (!driver) return { success: false, error: `No driver for type: ${device.driverType}` };
      const result = await driver.connect(device.connectionParams);
      if (result.success) {
        this.activeDrivers.set(id, driver);
        hardwareEventBus.emit('device:connected', {
          driverType: device.driverType,
          displayName: device.displayName,
        }, id, device.deviceRole);
      } else {
        hardwareEventBus.emit('device:error', {
          error: result.error,
          displayName: device.displayName,
        }, id, device.deviceRole);
      }
      return result;
    } catch (error) {
      const message = (error as Error).message;
      hardwareEventBus.emit('device:error', { error: message }, id, device.deviceRole);
      return { success: false, error: message };
    }
  }

  async disconnectAll(): Promise<void> {
    for (const [id, driver] of this.activeDrivers) {
      try { await driver.disconnect(); }
      catch (error) { console.error(`[BrowserHardwareAdapter] Failed to disconnect ${id}:`, error); }
    }
    this.activeDrivers.clear();
  }

  /**
   * Execute a command on the device assigned to a specific role.
   * Connects on-demand if the driver hasn't been spun up yet.
   */
  async executeForRole(role: DeviceRole, command: DriverCommand): Promise<DriverResult> {
    const deviceId = this.roleAssignments.get(role);
    if (!deviceId) return { success: false, error: `No device assigned for role: ${role}` };

    const driver = this.activeDrivers.get(deviceId);
    if (!driver) {
      const device = this.devices.get(deviceId);
      if (!device) return { success: false, error: `Device config not found: ${deviceId}` };
      const connectResult = await this.connectDevice(deviceId, device);
      if (!connectResult.success) return { success: false, error: `Failed to connect: ${connectResult.error}` };
      const newDriver = this.activeDrivers.get(deviceId);
      if (!newDriver) return { success: false, error: 'Driver initialization failed' };
      return newDriver.execute(command);
    }
    return driver.execute(command);
  }

  /**
   * Generic exec — same `(role, op, payload)` envelope as the Electron
   * main-process CommandRouter. This is the single dispatch point the
   * HardwareClient browser fallback now uses; all role/op pairs route
   * through here so no platform branching leaks into UI code.
   */
  async exec(cmd: ExecCommandInput): Promise<DriverResult> {
    switch (`${cmd.role}:${cmd.op}`) {
      case 'receipt_printer:print_receipt':
        return this.executeForRole('receipt_printer', { type: 'print_receipt', payload: cmd.payload });
      case 'receipt_printer:print_raw':
        return this.executeForRole('receipt_printer', { type: 'print_raw', payload: cmd.payload });
      // Audit Wave 9d.8 — canonical kitchen op is `print_receipt`. We keep
      // `print_ticket` as a deprecated alias so older callers keep
      // working; both branches route the same op string downstream.
      case 'kitchen_printer:print_receipt':
      case 'kitchen_printer:print_ticket': {
        const target: DeviceRole = this.roleAssignments.has('kitchen_printer')
          ? 'kitchen_printer'
          : 'receipt_printer';
        return this.executeForRole(target, { type: 'print_receipt', payload: cmd.payload });
      }
      // Audit Wave 9d.3 — `label_printer` is now first-class on the browser
      // path as well. When the operator has not bound a dedicated label
      // printer we fall back to the receipt printer (most thermal label
      // printers identify as ESC/POS receipt-class anyway). The PrintClient
      // (P1) will surface a non-misleading "no label printer" affordance
      // upstream of this fallback.
      case 'label_printer:print_raw':
      case 'label_printer:print_label':
      case 'label_printer:print_receipt': {
        const target: DeviceRole = this.roleAssignments.has('label_printer')
          ? 'label_printer'
          : 'receipt_printer';
        const type = cmd.op === 'print_receipt' ? 'print_receipt' : 'print_raw';
        // Normalize label payload → raw byte array. labelDispatch emits
        // `{ zpl }` / `{ epl }` / `{ bytes }` / `{ pdfUrl }` shaped for the
        // main-process label drivers; the renderer fallback speaks raw
        // bytes only, so extract/encode here before handing to the
        // transport. ADR-0087: when the payload carries media hints
        // (`mediaWidthMm`, `mediaHeightMm`, `dpi`), inject the paper
        // envelope so ZPL/EPL bodies rendered from `label_templates` scale
        // to the resolved media on the browser path too.
        const raw = cmd.payload as
          | number[]
          | Uint8Array
          | {
              bytes?: number[] | Uint8Array;
              zpl?: string;
              epl?: string;
              text?: string;
              mediaWidthMm?: number;
              mediaHeightMm?: number;
              dpi?: number;
            }
          | undefined;
        let bytes: number[] | Uint8Array | undefined;
        if (Array.isArray(raw) || raw instanceof Uint8Array) {
          bytes = raw;
        } else if (raw && typeof raw === 'object') {
          if (Array.isArray(raw.bytes) || raw.bytes instanceof Uint8Array) {
            bytes = raw.bytes;
          } else if (typeof raw.zpl === 'string') {
            const enveloped = injectZplEnvelope(raw.zpl, raw);
            bytes = Array.from(new TextEncoder().encode(enveloped));
          } else if (typeof raw.epl === 'string') {
            const enveloped = injectEplEnvelope(raw.epl, raw);
            bytes = Array.from(new TextEncoder().encode(enveloped));
          } else if (typeof raw.text === 'string') {
            bytes = Array.from(new TextEncoder().encode(raw.text));
          }
        }
        if (!bytes || (Array.isArray(bytes) && bytes.length === 0)) {
          return { success: false, error: `label_printer:${cmd.op} payload missing bytes/zpl/epl/text` };
        }
        return this.executeForRole(target, { type, payload: bytes });
      }
      case 'cash_drawer:open': {
        const p = cmd.payload as { pin?: 2 | 5 } | undefined;
        return this.executeForRole('cash_drawer', { type: 'open_drawer', payload: { pin: p?.pin } });
      }
      case 'scale:read':
        return this.executeForRole('scale', { type: 'read_weight' });
      case 'scale:tare':
        return this.executeForRole('scale', { type: 'tare' });
      case 'customer_display:update':
        return this.executeForRole('customer_display', { type: 'update_display', payload: cmd.payload });
      case 'payment_terminal:initiate_payment': {
        const p = cmd.payload as { amount: number; currency: string; reference: string };
        return this.executeForRole('payment_terminal', {
          type: 'initiate_payment',
          payload: { amount: p.amount, currency: p.currency, reference: p.reference },
        });
      }
      case 'payment_terminal:cancel_payment':
        return this.executeForRole('payment_terminal', { type: 'cancel_payment' });
      default:
        return { success: false, error: `unsupported op ${cmd.role}:${cmd.op} in browser adapter` };
    }
  }

  getAllStatuses(): Map<string, {
    role: DeviceRole;
    displayName: string;
    status: ReturnType<IDriver['getStatus']>;
    lastError?: string;
  }> {
    const statuses = new Map();
    for (const [id, device] of this.devices) {
      const driver = this.activeDrivers.get(id);
      const driverStatus = driver?.getStatus() ?? { connected: false, status: 'offline' as const };
      statuses.set(id, {
        role: device.deviceRole,
        displayName: device.displayName,
        status: driverStatus,
        lastError: (driverStatus as { lastError?: string }).lastError,
      });
    }
    return statuses;
  }

  isRoleAvailable(role: DeviceRole): boolean {
    const deviceId = this.roleAssignments.get(role);
    if (!deviceId) return false;
    const driver = this.activeDrivers.get(deviceId);
    return driver?.getStatus().connected ?? false;
  }

  async healthCheck(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    for (const [id, driver] of this.activeDrivers) {
      try { results.set(id, await driver.testConnection()); }
      catch { results.set(id, false); }
    }
    return results;
  }

  getDriverForRole(role: DeviceRole): IDriver | null {
    const deviceId = this.roleAssignments.get(role);
    if (!deviceId) return null;
    return this.activeDrivers.get(deviceId) ?? null;
  }

  async reconnectRole(role: DeviceRole): Promise<DriverResult> {
    const deviceId = this.roleAssignments.get(role);
    if (!deviceId) return { success: false, error: `No device assigned for role: ${role}` };
    const device = this.devices.get(deviceId);
    if (!device) return { success: false, error: `Device config not found: ${deviceId}` };
    const existing = this.activeDrivers.get(deviceId);
    if (existing) {
      try { await existing.disconnect(); } catch { /* ignore */ }
      this.activeDrivers.delete(deviceId);
    }
    return this.connectDevice(deviceId, device);
  }
}

/** Singleton — the renderer-side hardware runtime. */
export const browserHardwareAdapter = new BrowserHardwareAdapterService();
