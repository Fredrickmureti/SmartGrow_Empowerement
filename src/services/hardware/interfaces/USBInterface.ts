/**
 * USB Interface — Auto-discovery for USB devices via WebUSB.
 * 
 * Polls navigator.usb.getDevices() to detect previously paired USB devices.
 * New (unpaired) devices require a user gesture — the interface emits
 * events for already-known devices and provides requestDevice() for manual pairing.
 */

import { HardwareInterface, type DiscoveredDevice } from './InterfaceBase';
import { KNOWN_PRINTER_VENDORS, KNOWN_SCALE_VENDORS, KNOWN_SCANNER_VENDORS } from '../escpos-commands';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getNavigatorUSB = (): any => (navigator as any).usb;

export class USBInterface extends HardwareInterface {
  readonly interfaceName = 'USBInterface';
  readonly connectionType = 'usb' as const;

  constructor() {
    super();
    this.pollingIntervalMs = 3000; // Match Odoo's 3s USB poll
  }

  async detectDevices(): Promise<DiscoveredDevice[]> {
    const usb = getNavigatorUSB();
    if (!usb) return [];

    try {
      const devices = await usb.getDevices();
      return devices.map((d: any) => this.toDiscoveredDevice(d));
    } catch {
      return [];
    }
  }

  /**
   * Request user to pair a new USB device (requires user gesture)
   */
  async requestDevice(filters?: Array<{ vendorId?: number; productId?: number; classCode?: number }>): Promise<DiscoveredDevice | null> {
    const usb = getNavigatorUSB();
    if (!usb) return null;

    try {
      const device = await usb.requestDevice({
        filters: filters || [
          { classCode: 7 }, // Printers
          // Common POS vendor IDs
          ...Object.keys(KNOWN_PRINTER_VENDORS).map(v => ({ vendorId: parseInt(v) })),
        ],
      });

      return this.toDiscoveredDevice(device);
    } catch {
      return null; // User cancelled
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toDiscoveredDevice(device: any): DiscoveredDevice {
    const vendorId = device.vendorId as number;
    const productId = device.productId as number;
    const vendorName =
      KNOWN_PRINTER_VENDORS[vendorId] ||
      KNOWN_SCALE_VENDORS[vendorId] ||
      KNOWN_SCANNER_VENDORS[vendorId] ||
      device.manufacturerName ||
      'Unknown';

    return {
      identifier: `usb:${vendorId.toString(16).padStart(4, '0')}:${productId.toString(16).padStart(4, '0')}`,
      name: device.productName || `${vendorName} Device (${productId.toString(16)})`,
      connectionType: 'usb',
      vendorId,
      productId,
      manufacturer: vendorName,
      deviceClass: device.deviceClass,
      rawDevice: device,
    };
  }
}
