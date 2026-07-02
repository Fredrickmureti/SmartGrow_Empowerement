/**
 * HID Scanner Driver — WebHID-based USB barcode scanner driver.
 * 
 * Uses the WebHID API to communicate directly with USB HID barcode
 * scanners rather than relying on keyboard emulation. This provides:
 * - Explicit device selection (no accidental keyboard capture)
 * - Works even when the browser window is not focused
 * - Access to raw scan data including symbology info
 * 
 * Requires WebHID support (Chrome 89+, Edge 89+).
 */

import type {
  IDriver, DriverType, DeviceRole, ConnectionBackend,
  DeviceStatus, DriverCommand, DriverResult, DeviceInfo,
} from './DriverInterface';
import { hardwareEventBus } from '../HardwareEventBus';
import { KNOWN_SCANNER_VENDORS } from '../escpos-commands';

type BarcodeCallback = (barcode: string) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getNavigatorHID = (): any => (navigator as any).hid;

export class HidScannerDriver implements IDriver {
  readonly driverType: DriverType = 'hid_scanner';
  readonly supportedRoles: DeviceRole[] = ['barcode_scanner'];
  readonly supportedBackends: ConnectionBackend[] = ['browser', 'electron'];

  supported(deviceInfo: DeviceInfo): number {
    if (deviceInfo.vendorId && KNOWN_SCANNER_VENDORS[deviceInfo.vendorId]) return 10;
    // HID devices that aren't keyboards/mice might be scanners
    if (deviceInfo.connectionType === 'usb' && deviceInfo.deviceClass === 0) return 3;
    return 0;
  }

  private connected = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private device: any = null;
  private listeners: BarcodeCallback[] = [];
  private buffer = '';
  private lastError: string | undefined;

  async connect(params: Record<string, unknown>): Promise<DriverResult> {
    const hid = getNavigatorHID();
    if (!hid) {
      return { success: false, error: 'WebHID API not available in this browser' };
    }

    try {
      const vendorId = params.vendorId as number | undefined;
      const productId = params.productId as number | undefined;

      // Try to get previously paired device first
      let devices = await hid.getDevices();
      let device = devices.find((d: any) =>
        (!vendorId || d.vendorId === vendorId) &&
        (!productId || d.productId === productId)
      );

      // If not found, request user to pick one
      if (!device) {
        const filters = vendorId ? [{ vendorId, productId }] : [];
        const selected = await hid.requestDevice({ filters });
        device = selected[0];
      }

      if (!device) {
        return { success: false, error: 'No HID device selected' };
      }

      if (!device.opened) {
        await device.open();
      }

      device.addEventListener('inputreport', this.handleInputReport.bind(this));

      this.device = device;
      this.connected = true;
      this.lastError = undefined;

      console.log('[HidScanner] Connected to:', device.productName || `${device.vendorId}:${device.productId}`);
      return { success: true };
    } catch (error) {
      this.lastError = (error as Error).message;
      return { success: false, error: this.lastError };
    }
  }

  async disconnect(): Promise<DriverResult> {
    if (this.device?.opened) {
      try {
        await this.device.close();
      } catch {
        // ignore
      }
    }
    this.device = null;
    this.connected = false;
    this.listeners = [];
    return { success: true };
  }

  getStatus(): DeviceStatus {
    return {
      connected: this.connected,
      status: this.connected ? 'online' : 'offline',
      lastError: this.lastError,
    };
  }

  async execute(command: DriverCommand): Promise<DriverResult> {
    switch (command.type) {
      case 'subscribe_barcode': {
        const callback = (command.payload as { callback: BarcodeCallback })?.callback;
        if (callback) this.listeners.push(callback);
        return { success: true };
      }
      default:
        return { success: false, error: `Unknown command: ${command.type}` };
    }
  }

  async testConnection(): Promise<boolean> {
    return this.connected && !!this.device?.opened;
  }

  onBarcode(callback: BarcodeCallback): void {
    this.listeners.push(callback);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleInputReport(event: any): void {
    const data = new Uint8Array(event.data.buffer);

    // Most HID scanners send USB HID keyboard usage pages
    // Byte 0: modifier keys, Byte 2+: key codes
    for (let i = 2; i < data.length; i++) {
      const keyCode = data[i];
      if (keyCode === 0) continue;

      // Enter key (0x28) = end of barcode
      if (keyCode === 0x28) {
        if (this.buffer.length > 0) {
          this.emitBarcode(this.buffer);
          this.buffer = '';
        }
        continue;
      }

      const char = this.hidKeyCodeToChar(keyCode, (data[0] & 0x02) !== 0);
      if (char) {
        this.buffer += char;
      }
    }
  }

  private hidKeyCodeToChar(keyCode: number, shift: boolean): string | null {
    // USB HID Usage Table — Keyboard page
    if (keyCode >= 0x04 && keyCode <= 0x1D) {
      // a-z
      const c = String.fromCharCode(keyCode - 0x04 + 97);
      return shift ? c.toUpperCase() : c;
    }
    if (keyCode >= 0x1E && keyCode <= 0x26) {
      // 1-9
      return String.fromCharCode(keyCode - 0x1E + 49);
    }
    if (keyCode === 0x27) return '0';
    if (keyCode === 0x2D) return '-';
    if (keyCode === 0x2E) return '=';
    if (keyCode === 0x2F) return '[';
    if (keyCode === 0x30) return ']';
    if (keyCode === 0x33) return ';';
    if (keyCode === 0x34) return "'";
    if (keyCode === 0x36) return ',';
    if (keyCode === 0x37) return '.';
    if (keyCode === 0x38) return '/';
    if (keyCode === 0x2C) return ' ';
    return null;
  }

  private emitBarcode(barcode: string): void {
    console.log('[HidScanner] Barcode scanned:', barcode);
    for (const listener of this.listeners) {
      try {
        listener(barcode);
      } catch (err) {
        console.error('[HidScanner] Listener error:', err);
      }
    }
    // Emit via centralized event bus (also bridges to DOM for backward compat)
    hardwareEventBus.emit('scanner:barcode_scanned', { barcode }, undefined, 'barcode_scanner');
  }
}
