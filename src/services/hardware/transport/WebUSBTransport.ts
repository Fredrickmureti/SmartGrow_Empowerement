/**
 * WebUSB Transport — Direct browser-to-USB-device access.
 *
 * Uses the WebUSB API (Chrome/Edge) to communicate with USB printers
 * without requiring Electron or a local agent.
 *
 * Limitations:
 * - Requires user gesture for initial pairing
 * - Only available in secure contexts (HTTPS or localhost)
 * - Not all USB devices are accessible (platform-specific restrictions)
 */

import type { ITransport, TransportResult, USBTarget } from './TransportAdapter';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getNavigatorUSB = (): any => (navigator as any).usb;

interface WebUSBDevice {
  vendorId: number;
  productId: number;
  configuration?: {
    interfaces: Array<{
      alternates: Array<{
        endpoints: Array<{
          direction: string;
          type: string;
          endpointNumber: number;
        }>;
      }>;
    }>;
  };
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  transferOut(endpointNumber: number, data: ArrayBuffer | ArrayBufferView): Promise<{ bytesWritten: number }>;
}

export class WebUSBTransport implements ITransport {
  readonly name = 'WebUSB';
  private target: USBTarget;
  private device: WebUSBDevice | null = null;
  private endpointNumber: number | null = null;

  constructor(target: USBTarget) {
    this.target = target;
  }

  isAvailable(): boolean {
    return !!getNavigatorUSB();
  }

  async send(data: number[] | Uint8Array): Promise<TransportResult> {
    if (!this.device || this.endpointNumber === null) {
      const connectResult = await this._ensureConnected();
      if (!connectResult.success) return connectResult;
    }

    try {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      const result = await this.device!.transferOut(this.endpointNumber!, bytes);
      return { success: true, bytesWritten: result.bytesWritten };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async test(): Promise<TransportResult> {
    return this._ensureConnected();
  }

  async disconnect(): Promise<void> {
    if (this.device) {
      try { await this.device.close(); } catch { /* ignore */ }
      this.device = null;
      this.endpointNumber = null;
    }
  }

  private async _ensureConnected(): Promise<TransportResult> {
    const usb = getNavigatorUSB();
    if (!usb) {
      return { success: false, error: 'WebUSB not supported in this browser' };
    }

    try {
      const devices: WebUSBDevice[] = await usb.getDevices();
      let device = devices.find(
        (d: WebUSBDevice) => d.vendorId === this.target.vendorId && d.productId === this.target.productId,
      );

      if (!device) {
        device = await usb.requestDevice({
          filters: [{ vendorId: this.target.vendorId, productId: this.target.productId }],
        });
      }

      await device.open();
      await device.selectConfiguration(1);
      await device.claimInterface(0);

      const iface = device.configuration?.interfaces[0];
      const alternate = iface?.alternates[0];
      const endpoint = alternate?.endpoints.find(
        (e) => e.direction === 'out' && e.type === 'bulk',
      );

      if (!endpoint) {
        await device.close();
        return { success: false, error: 'No suitable USB endpoint found' };
      }

      this.device = device;
      this.endpointNumber = endpoint.endpointNumber;
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}
