/**
 * Hardware Interface Base — Abstract base for device discovery interfaces.
 * 
 * Mirrors Odoo's Interface pattern:
 * - Each Interface scans one connection backend (USB, Serial, Network)
 * - Returns a list of discovered devices
 * - Runs a polling loop at a configurable interval
 * - New devices are emitted via the HardwareEventBus
 */

import { hardwareEventBus, type DeviceDiscoveredData } from '../HardwareEventBus';

export interface DiscoveredDevice {
  /** Unique identifier: e.g. "usb:04b8:0202", "network:192.168.1.100:9100" */
  identifier: string;
  /** Human-readable name */
  name: string;
  /** Connection backend */
  connectionType: 'usb' | 'serial' | 'network' | 'bluetooth';
  /** Vendor ID (USB/HID) */
  vendorId?: number;
  /** Product ID (USB/HID) */
  productId?: number;
  /** IP address (network) */
  ipAddress?: string;
  /** Port (network/serial) */
  port?: number;
  /** Serial port path */
  portPath?: string;
  /** Raw device reference (for re-use without user gesture) */
  rawDevice?: unknown;
  /** USB device class */
  deviceClass?: number;
  /** Manufacturer name */
  manufacturer?: string;
}

export abstract class HardwareInterface {
  abstract readonly interfaceName: string;
  abstract readonly connectionType: 'usb' | 'serial' | 'network' | 'bluetooth';

  protected pollingIntervalMs = 5000;
  private timer: ReturnType<typeof setInterval> | null = null;
  private knownDevices = new Map<string, DiscoveredDevice>();
  private _isScanning = false;

  get isScanning(): boolean {
    return this._isScanning;
  }

  /**
   * Override in subclass: detect currently connected devices
   */
  abstract detectDevices(): Promise<DiscoveredDevice[]>;

  /**
   * Start background scanning loop
   */
  startPolling(intervalMs?: number): void {
    if (this.timer) return;
    if (intervalMs) this.pollingIntervalMs = intervalMs;

    console.log(`[${this.interfaceName}] Starting discovery polling (${this.pollingIntervalMs}ms)`);
    this._isScanning = true;

    // Initial scan
    this.scan();

    this.timer = setInterval(() => this.scan(), this.pollingIntervalMs);
  }

  /**
   * Stop background scanning
   */
  stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._isScanning = false;
    console.log(`[${this.interfaceName}] Stopped discovery polling`);
  }

  /**
   * Run a single scan cycle
   */
  async scan(): Promise<DiscoveredDevice[]> {
    try {
      const devices = await this.detectDevices();

      // Detect newly appeared devices
      for (const device of devices) {
        if (!this.knownDevices.has(device.identifier)) {
          this.knownDevices.set(device.identifier, device);
          this.emitDiscovered(device);
        }
      }

      // Detect removed devices
      const currentIds = new Set(devices.map(d => d.identifier));
      for (const [id] of this.knownDevices) {
        if (!currentIds.has(id)) {
          this.knownDevices.delete(id);
        }
      }

      return devices;
    } catch (error) {
      console.error(`[${this.interfaceName}] Scan error:`, error);
      return [];
    }
  }

  /**
   * Get all currently known devices
   */
  getKnownDevices(): DiscoveredDevice[] {
    return Array.from(this.knownDevices.values());
  }

  /**
   * Clear known devices cache (force re-discovery)
   */
  clearCache(): void {
    this.knownDevices.clear();
  }

  private emitDiscovered(device: DiscoveredDevice): void {
    const data: DeviceDiscoveredData = {
      identifier: device.identifier,
      name: device.name,
      vendorId: device.vendorId,
      productId: device.productId,
      connectionType: device.connectionType,
    };

    console.log(`[${this.interfaceName}] New device discovered:`, data);
    hardwareEventBus.emit('device:discovered', data);
  }
}
