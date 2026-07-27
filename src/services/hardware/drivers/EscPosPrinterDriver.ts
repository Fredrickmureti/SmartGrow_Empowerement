/**
 * ESC/POS Printer Driver
 *
 * Routes print jobs through the unified TransportAdapter layer.
 * The driver produces ESC/POS bytes; the transport delivers them.
 *
 * Transport selection is fully delegated to `TransportRouter` via
 * `resolveTransport()`. This driver never checks isPrivateIP, isElectron,
 * or chooses between agents — it only produces bytes.
 */

import type {
  IDriver, DriverType, DeviceRole, ConnectionBackend,
  DeviceStatus, DriverCommand, DriverResult, DeviceInfo,
} from './DriverInterface';
import { KNOWN_PRINTER_VENDORS } from '../escpos-commands';
import { resolveTransport, type ITransport, type ResolveTransportOptions } from '../transport';

export class EscPosPrinterDriver implements IDriver {
  readonly driverType: DriverType = 'escpos';
  // Label printers get dedicated drivers (zpl_label / epl_label / escpos_label);
  // ESC/POS receipt drivers no longer masquerade as label printers.
  readonly supportedRoles: DeviceRole[] = ['receipt_printer', 'kitchen_printer'];
  readonly supportedBackends: ConnectionBackend[] = ['electron', 'webusb', 'local_proxy', 'network'];

  private _status: DeviceStatus = { connected: false, status: 'unknown' };
  private _transport: ITransport | null = null;
  private _connectionParams: Record<string, unknown> = {};
  private _consecutiveTestFailures = 0;
  /** After this many consecutive failed probes, mark the device disconnected. */
  private static readonly FAILURE_THRESHOLD = 2;

  supported(deviceInfo: DeviceInfo): number {
    if (deviceInfo.connectionType === 'usb' && deviceInfo.deviceClass === 7) return 10;
    if (deviceInfo.vendorId && KNOWN_PRINTER_VENDORS[deviceInfo.vendorId]) return 8;
    if (deviceInfo.connectionType === 'network') return 5;
    return 0;
  }

  async connect(params: Record<string, unknown>): Promise<DriverResult> {
    this._connectionParams = params;
    const transport_ = (params.transport as string | undefined)
      ?? (params.connection_type as string | undefined)
      ?? 'local_agent';

    // Build transport options from connection params
    const transportOpts: ResolveTransportOptions = {
      transport: transport_,
      ipAddress: params.ipAddress as string | undefined,
      port: params.port as number | undefined,
      vendorId: params.vendorId as number | undefined,
      productId: params.productId as number | undefined,
    };

    const transport = resolveTransport(transportOpts);
    if (!transport) {
      this._status = { connected: false, status: 'error', lastError: `No transport for ${transport_}` };
      return { success: false, error: `No available transport for: ${transport_}` };
    }

    this._transport = transport;

    // Test the transport
    const testResult = await transport.test();
    this._consecutiveTestFailures = 0;
    if (testResult.success) {
      this._status = { connected: true, status: 'online', lastSeenAt: new Date().toISOString() };
      return { success: true };
    }

    this._status = { connected: false, status: 'error', lastError: testResult.error };
    return { success: false, error: testResult.error };
  }

  async disconnect(): Promise<DriverResult> {
    if (this._transport) {
      await this._transport.disconnect();
      this._transport = null;
    }
    this._status = { connected: false, status: 'offline' };
    return { success: true };
  }

  getStatus(): DeviceStatus {
    if (this._transport && !this._transport.isAvailable() && this._status.connected) {
      this._status = {
        connected: false,
        status: 'offline',
        lastError: `Transport ${this._transport.name} no longer available`,
      };
    }
    return { ...this._status };
  }

  async execute(command: DriverCommand): Promise<DriverResult> {
    if (!this._transport) {
      return { success: false, error: 'Not connected — no transport available' };
    }

    if (command.type === 'print_receipt') {
      const payload = command.payload as { bytes?: number[] | Uint8Array } | number[] | Uint8Array;
      const data = Array.isArray(payload) || payload instanceof Uint8Array
        ? payload
        : payload?.bytes;
      if (!data || !(Array.isArray(data) || data instanceof Uint8Array)) {
        return {
          success: false,
          error: 'print_receipt requires server-rendered ESC/POS bytes; local receipt encoding is disabled.',
        };
      }
      const result = await this._transport.send(data);
      return { success: result.success, error: result.error };
    }

    if (command.type === 'print_raw') {
      const p = command.payload as
        | number[]
        | Uint8Array
        | { bytes?: number[] | Uint8Array; zpl?: string; epl?: string; text?: string }
        | undefined;
      let data: number[] | Uint8Array | undefined;
      if (Array.isArray(p) || p instanceof Uint8Array) {
        data = p;
      } else if (p && typeof p === 'object') {
        if (Array.isArray(p.bytes) || p.bytes instanceof Uint8Array) data = p.bytes;
        else if (typeof p.zpl === 'string') data = Array.from(new TextEncoder().encode(p.zpl));
        else if (typeof p.epl === 'string') data = Array.from(new TextEncoder().encode(p.epl));
        else if (typeof p.text === 'string') data = Array.from(new TextEncoder().encode(p.text));
      }
      if (!data || (Array.isArray(data) && data.length === 0)) {
        return { success: false, error: 'print_raw payload missing bytes' };
      }
      const result = await this._transport.send(data);
      return { success: result.success, error: result.error };
    }

    return { success: false, error: `Unknown command: ${command.type}` };
  }

  async testConnection(): Promise<boolean> {
    if (!this._transport) return false;

    const result = await this._transport.test();
    if (result.success) {
      this._consecutiveTestFailures = 0;
      this._status.connected = true;
      this._status.status = 'online';
      this._status.lastError = undefined;
      this._status.lastSeenAt = new Date().toISOString();
      return true;
    }

    this._consecutiveTestFailures += 1;
    this._status.lastError = result.error;
    // Tolerate transient probe failures — only flip to offline after N in a row.
    if (this._consecutiveTestFailures >= EscPosPrinterDriver.FAILURE_THRESHOLD) {
      this._status.connected = false;
      this._status.status = 'offline';
      console.warn(
        `[EscPosPrinterDriver] marking offline after ${this._consecutiveTestFailures} failed probes:`,
        result.error,
      );
      return false;
    }
    console.debug(
      `[EscPosPrinterDriver] transient probe failure (${this._consecutiveTestFailures}/${EscPosPrinterDriver.FAILURE_THRESHOLD}):`,
      result.error,
    );
    // Keep last-known connected flag — UI does not flap.
    return this._status.connected;
  }
}
