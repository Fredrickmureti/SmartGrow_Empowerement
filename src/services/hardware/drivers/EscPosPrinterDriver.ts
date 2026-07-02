/**
 * ESC/POS Printer Driver
 *
 * Routes print jobs through the unified TransportAdapter layer.
 * The driver produces ESC/POS bytes; the transport delivers them.
 *
 * Transport selection is fully delegated to `resolveTransport()`.
 * This driver never checks isPrivateIP, isElectron, or chooses
 * between edge functions vs local agents. That's the transport's job.
 */

import type {
  IDriver, DriverType, DeviceRole, ConnectionBackend,
  DeviceStatus, DriverCommand, DriverResult, PrintCommand, DeviceInfo,
} from './DriverInterface';
import { KNOWN_PRINTER_VENDORS } from '../escpos-commands';
import { resolveTransport, type ITransport, type ResolveTransportOptions } from '../transport';

export class EscPosPrinterDriver implements IDriver {
  readonly driverType: DriverType = 'escpos';
  readonly supportedRoles: DeviceRole[] = ['receipt_printer', 'kitchen_printer', 'label_printer'];
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
    const connectionType = (params.connection_type as string) || 'network';

    // Build transport options from connection params
    const transportOpts: ResolveTransportOptions = {
      connectionType: connectionType as ResolveTransportOptions['connectionType'],
      ipAddress: params.ipAddress as string | undefined,
      port: params.port as number | undefined,
      vendorId: params.vendorId as number | undefined,
      productId: params.productId as number | undefined,
    };

    const transport = resolveTransport(transportOpts);
    if (!transport) {
      this._status = { connected: false, status: 'error', lastError: `No transport for ${connectionType}` };
      return { success: false, error: `No available transport for connection type: ${connectionType}` };
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
      const data = this._buildReceiptBytes(command as PrintCommand);
      const result = await this._transport.send(data);
      return { success: result.success, error: result.error };
    }

    if (command.type === 'print_raw') {
      const result = await this._transport.send(command.payload as number[] | Uint8Array);
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

  // ═══════════════════════════════════════════
  //  ESC/POS byte builder
  // ═══════════════════════════════════════════

  private _buildReceiptBytes(printCmd: PrintCommand): number[] {
    const encoder = new TextEncoder();
    const data: number[] = [0x1b, 0x40]; // ESC @ (init)

    // Header
    if (printCmd.payload.header) {
      data.push(0x1b, 0x61, 0x01); // center
      data.push(0x1b, 0x45, 0x01); // bold on
      for (const h of printCmd.payload.header) {
        data.push(...encoder.encode(h.text), 0x0a);
      }
      data.push(0x1b, 0x45, 0x00); // bold off
      data.push(0x0a);
    }

    // Lines
    for (const line of printCmd.payload.lines) {
      const align = line.align === 'center' ? 0x01 : line.align === 'right' ? 0x02 : 0x00;
      data.push(0x1b, 0x61, align);
      if (line.bold) data.push(0x1b, 0x45, 0x01);
      if (line.doubleWidth) data.push(0x1d, 0x21, 0x10);
      if (line.doubleHeight) data.push(0x1d, 0x21, 0x01);
      data.push(...encoder.encode(line.text), 0x0a);
      if (line.bold) data.push(0x1b, 0x45, 0x00);
      if (line.doubleWidth || line.doubleHeight) data.push(0x1d, 0x21, 0x00);
    }

    // Footer
    if (printCmd.payload.footer) {
      data.push(0x0a);
      data.push(0x1b, 0x61, 0x01); // center
      for (const f of printCmd.payload.footer) {
        data.push(...encoder.encode(f.text), 0x0a);
      }
    }

    // Feed + cut
    if (printCmd.payload.cut !== false) {
      data.push(0x1b, 0x64, 0x04); // feed 4 lines
      data.push(0x1d, 0x56, 0x41, 0x03); // partial cut
    }

    // Open drawer
    if (printCmd.payload.openDrawer) {
      data.push(0x1b, 0x70, 0x00, 0x19, 0x78); // pin 2
    }

    return data;
  }
}
