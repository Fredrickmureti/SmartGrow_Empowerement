/**
 * Keyboard Scanner Driver — hardware-registry descriptor for a
 * keyboard-wedge barcode scanner.
 *
 * This driver does NOT decode keystrokes. There is exactly one
 * keyboard-wedge decoder in the platform — `useScanCapture`
 * (`src/hooks/pos/useScanCapture.ts`) — mounted once in the authenticated
 * shell, which emits parsed `ScanEvent`s on `scanBus`. A second
 * capture-phase keydown decoder here would double-decode, double-
 * `preventDefault()`, and bypass router precedence, dedupe and telemetry.
 *
 * So the driver is a pure *bridge*: it subscribes to `scanBus` while the
 * device is "connected" and republishes wedge scans onto
 * `hardwareEventBus` for device-status/diagnostics consumers.
 *
 * Guarded by `src/test/architecture/single-wedge-decoder.test.ts`.
 */

import type {
  IDriver, DriverType, DeviceRole, ConnectionBackend,
  DeviceStatus, DriverCommand, DriverResult, DeviceInfo,
} from './DriverInterface';
import { hardwareEventBus } from '../HardwareEventBus';
import { scanBus } from '@/services/pos/scanBus';

export type BarcodeCallback = (barcode: string) => void;

export class KeyboardScannerDriver implements IDriver {
  readonly driverType: DriverType = 'keyboard_scanner';
  readonly supportedRoles: DeviceRole[] = ['barcode_scanner'];
  readonly supportedBackends: ConnectionBackend[] = ['browser', 'electron'];

  supported(deviceInfo: DeviceInfo): number {
    // Keyboard scanners don't match USB devices — they use the keyboard path
    if (deviceInfo.connectionType === 'browser') return 5;
    return 0;
  }

  private connected = false;
  private lastBarcode = '';
  private minLength = 4;
  private listeners: BarcodeCallback[] = [];
  private unsubscribe: (() => void) | null = null;

  async connect(params: Record<string, unknown>): Promise<DriverResult> {
    if (this.connected) return { success: true };

    this.minLength = (params.minLength as number) || 4;

    // Bridge, not decoder: the kernel already decoded and deduped.
    this.unsubscribe = scanBus.on((event) => {
      if (event.source !== 'keyboard') return;
      if (event.code.length < this.minLength) return;
      this.emitBarcode(event.code);
    });

    this.connected = true;
    return { success: true };
  }

  async disconnect(): Promise<DriverResult> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.connected = false;
    this.lastBarcode = '';
    this.listeners = [];
    return { success: true };
  }

  getStatus(): DeviceStatus {
    return {
      connected: this.connected,
      status: this.connected ? 'online' : 'offline',
    };
  }

  async execute(command: DriverCommand): Promise<DriverResult> {
    switch (command.type) {
      case 'subscribe_barcode': {
        const callback = (command.payload as { callback: BarcodeCallback })?.callback;
        if (callback) this.listeners.push(callback);
        return { success: true };
      }
      case 'get_last_barcode':
        return { success: true, data: this.lastBarcode };
      default:
        return { success: false, error: `Unknown command: ${command.type}` };
    }
  }

  async testConnection(): Promise<boolean> {
    return this.connected;
  }

  /** Register an external barcode listener */
  onBarcode(callback: BarcodeCallback): void {
    this.listeners.push(callback);
  }

  private emitBarcode(barcode: string): void {
    this.lastBarcode = barcode;
    for (const listener of this.listeners) {
      try {
        listener(barcode);
      } catch (err) {
        console.error('[KeyboardScanner] Listener error:', err);
      }
    }

    // Emit via centralized event bus (also bridges to DOM for backward compat)
    hardwareEventBus.emit('scanner:barcode_scanned', { barcode }, undefined, 'barcode_scanner');
  }
}
