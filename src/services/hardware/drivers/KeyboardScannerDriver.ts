/**
 * Keyboard Scanner Driver — Handles keyboard-wedge barcode scanners.
 * 
 * Most barcode scanners emulate a keyboard: they type characters rapidly
 * and terminate with Enter. This driver detects that pattern and fires
 * barcode events instead of letting keystrokes pollute input fields.
 * 
 * Configuration params:
 *   - minLength: minimum barcode length (default 4)
 *   - maxGapMs: max time between keystrokes to be considered part of a scan (default 50ms)
 *   - prefix: optional prefix character code to trigger scan mode
 *   - suffix: suffix character code that ends a scan (default 13 = Enter)
 */

import type {
  IDriver, DriverType, DeviceRole, ConnectionBackend,
  DeviceStatus, DriverCommand, DriverResult, DeviceInfo,
} from './DriverInterface';
import { hardwareEventBus } from '../HardwareEventBus';

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
  private buffer = '';
  private lastKeyTime = 0;
  private minLength = 4;
  private maxGapMs = 50;
  private suffixCode = 13; // Enter
  private prefixCode: number | null = null;
  private inScanMode = false;
  private listeners: BarcodeCallback[] = [];
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  async connect(params: Record<string, unknown>): Promise<DriverResult> {
    if (this.connected) return { success: true };

    this.minLength = (params.minLength as number) || 4;
    this.maxGapMs = (params.maxGapMs as number) || 50;
    this.suffixCode = (params.suffix as number) || 13;
    this.prefixCode = (params.prefix as number) || null;

    this.keydownHandler = this.handleKeydown.bind(this);
    document.addEventListener('keydown', this.keydownHandler, { capture: true });

    this.connected = true;
    console.log('[KeyboardScanner] Connected — listening for rapid keystroke sequences');
    return { success: true };
  }

  async disconnect(): Promise<DriverResult> {
    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler, { capture: true });
      this.keydownHandler = null;
    }
    this.connected = false;
    this.buffer = '';
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
        return { success: true, data: this.buffer };
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

  private handleKeydown(e: KeyboardEvent): void {
    const now = Date.now();

    // Check for prefix to enter scan mode
    if (this.prefixCode && e.keyCode === this.prefixCode && !this.inScanMode) {
      this.inScanMode = true;
      this.buffer = '';
      this.lastKeyTime = now;
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Check for suffix (scan complete)
    if (e.keyCode === this.suffixCode) {
      const gap = now - this.lastKeyTime;

      if (this.buffer.length >= this.minLength && (gap < this.maxGapMs || this.inScanMode)) {
        // This is a barcode scan
        e.preventDefault();
        e.stopPropagation();
        const barcode = this.buffer;
        this.buffer = '';
        this.inScanMode = false;
        this.emitBarcode(barcode);
        return;
      }

      // Not a scan — reset
      this.buffer = '';
      this.inScanMode = false;
      return;
    }

    // Accumulate characters
    const gap = now - this.lastKeyTime;
    if (gap > this.maxGapMs && !this.inScanMode) {
      // Too slow — reset buffer
      this.buffer = '';
    }

    // Only accept printable single characters
    if (e.key.length === 1) {
      this.buffer += e.key;
      this.lastKeyTime = now;

      // If we're in rapid-fire mode, suppress the keystroke from reaching inputs
      if (this.buffer.length >= 3 && gap < this.maxGapMs) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  }

  private emitBarcode(barcode: string): void {
    console.log('[KeyboardScanner] Barcode scanned:', barcode);
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
