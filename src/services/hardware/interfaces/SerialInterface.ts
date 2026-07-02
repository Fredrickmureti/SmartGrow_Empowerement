/**
 * Serial Interface — Auto-discovery for serial port devices via Web Serial API.
 * 
 * Polls navigator.serial.getPorts() to detect previously granted serial ports.
 * Like USB, new ports require a user gesture for initial pairing.
 */

import { HardwareInterface, type DiscoveredDevice } from './InterfaceBase';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getNavigatorSerial = (): any => (navigator as any).serial;

export class SerialInterface extends HardwareInterface {
  readonly interfaceName = 'SerialInterface';
  readonly connectionType = 'serial' as const;

  constructor() {
    super();
    this.pollingIntervalMs = 5000;
  }

  async detectDevices(): Promise<DiscoveredDevice[]> {
    const serial = getNavigatorSerial();
    if (!serial) return [];

    try {
      const ports = await serial.getPorts();
      return ports.map((port: any, index: number) => this.toDiscoveredDevice(port, index));
    } catch {
      return [];
    }
  }

  /**
   * Request user to select a serial port (requires user gesture)
   */
  async requestPort(filters?: Array<{ usbVendorId?: number; usbProductId?: number }>): Promise<DiscoveredDevice | null> {
    const serial = getNavigatorSerial();
    if (!serial) return null;

    try {
      const port = await serial.requestPort({ filters: filters || [] });
      return this.toDiscoveredDevice(port, 0);
    } catch {
      return null; // User cancelled
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toDiscoveredDevice(port: any, index: number): DiscoveredDevice {
    const info = port.getInfo?.() || {};
    const vendorId = info.usbVendorId;
    const productId = info.usbProductId;

    const identifier = vendorId && productId
      ? `serial:${vendorId.toString(16)}:${productId.toString(16)}`
      : `serial:port-${index}`;

    return {
      identifier,
      name: vendorId ? `Serial Device (${vendorId.toString(16)}:${productId?.toString(16)})` : `Serial Port ${index + 1}`,
      connectionType: 'serial',
      vendorId,
      productId,
      rawDevice: port,
    };
  }
}
