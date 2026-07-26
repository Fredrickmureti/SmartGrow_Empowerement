/**
 * USB device routes.
 *
 * Uses the `usb` npm package for cross-platform USB access.
 * If `usb` is not installed or fails to load (e.g. no native
 * build for the platform), these routes degrade gracefully.
 */

import { loadUsbRuntime, usbRuntimeSync, type UsbRuntime } from '../usb-runtime.js';

async function loadUsb(): Promise<UsbRuntime | null> {
  return loadUsbRuntime();
}

interface UsbDevice {
  vendorId: number;
  productId: number;
  name?: string;
  manufacturer?: string;
}

interface UsbDevicesResponse {
  devices: UsbDevice[];
}

interface UsbPrintRequest {
  vendorId: number;
  productId: number;
  data: number[];
}

interface UsbPrintResponse {
  success: boolean;
  error?: string;
}

export function handleUsbDevices(): UsbDevicesResponse {
  try {
    // Attempt synchronous usb access if already loaded
    const usb = usbRuntimeSync();
    if (!usb) {
      return { devices: [] };
    }

    const list: any[] = usb.getDeviceList();
    const devices: UsbDevice[] = list.map((d: any) => ({
      vendorId: d.deviceDescriptor.idVendor,
      productId: d.deviceDescriptor.idProduct,
    }));

    return { devices };
  } catch {
    return { devices: [] };
  }
}

export async function handleUsbPrint(body: UsbPrintRequest): Promise<UsbPrintResponse> {
  const { vendorId, productId, data } = body;

  if (vendorId == null || productId == null || !Array.isArray(data)) {
    return { success: false, error: 'Missing required fields: vendorId, productId, data' };
  }

  const usb = await loadUsb();
  if (!usb) {
    return { success: false, error: 'USB support not available — usb package not installed' };
  }

  try {
    const device = usb.findByIds(vendorId, productId);
    if (!device) {
      return { success: false, error: `USB device ${vendorId}:${productId} not found` };
    }

    device.open();

    const iface = device.interfaces?.[0];
    if (!iface) {
      device.close();
      return { success: false, error: 'No USB interface found on device' };
    }

    if (iface.isKernelDriverActive()) {
      iface.detachKernelDriver();
    }
    iface.claim();

    const outEndpoint = iface.endpoints.find((e: any) => e.direction === 'out');
    if (!outEndpoint || outEndpoint.direction !== 'out') {
      iface.release(() => device.close());
      return { success: false, error: 'No OUT endpoint found on USB device' };
    }

    const buf = Buffer.from(data);

    return new Promise((resolve) => {
      outEndpoint.transfer(buf, (err: any) => {
        iface.release(() => device.close());
        if (err) {
          resolve({ success: false, error: err.message });
        } else {
          resolve({ success: true });
        }
      });
    });
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
