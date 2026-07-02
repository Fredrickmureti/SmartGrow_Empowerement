/**
 * Browser Print Driver
 * Fallback driver for browser-only printing (no physical device).
 * Routes to the PDF pipeline for receipt printing.
 */

import type {
  IDriver, DriverType, DeviceRole, ConnectionBackend,
  DeviceStatus, DriverCommand, DriverResult, DeviceInfo,
} from './DriverInterface';

export class BrowserPrintDriver implements IDriver {
  readonly driverType: DriverType = 'browser_print';
  readonly supportedRoles: DeviceRole[] = ['receipt_printer', 'cash_drawer'];
  readonly supportedBackends: ConnectionBackend[] = ['browser'];

  supported(deviceInfo: DeviceInfo): number {
    // Browser print is the lowest-priority fallback
    if (deviceInfo.connectionType === 'browser') return 1;
    return 0;
  }

  private _status: DeviceStatus = { connected: true, status: 'online' };

  async connect(): Promise<DriverResult> {
    this._status = { connected: true, status: 'online', lastSeenAt: new Date().toISOString() };
    return { success: true };
  }

  async disconnect(): Promise<DriverResult> {
    this._status = { connected: false, status: 'offline' };
    return { success: true };
  }

  getStatus(): DeviceStatus {
    return this._status;
  }

  async execute(command: DriverCommand): Promise<DriverResult> {
    if (command.type === 'print_receipt') {
      // Browser print delegates to the PDF pipeline
      console.log('[BrowserPrintDriver] Receipt print requested — use PDF pipeline');
      return { success: true, data: { method: 'browser_pdf' } };
    }

    if (command.type === 'open_drawer') {
      console.log('[BrowserPrintDriver] Cash drawer open simulated (browser mode)');
      return { success: true, data: { simulated: true } };
    }

    return { success: false, error: `Unsupported command in browser mode: ${command.type}` };
  }

  async testConnection(): Promise<boolean> {
    return true; // Browser is always available
  }
}
