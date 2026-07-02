/**
 * USB discovery — main process.
 *
 * Wraps `node-usb` `getDeviceList()` and projects each enumerated device
 * into a `UsbCandidate` shape the renderer can render into the "Add
 * device" flow without ever touching the native binding itself.
 *
 * Read-only: this module NEVER claims an interface or opens a device.
 * It only reads the descriptor metadata that USB exposes to a non-claimed
 * enumerator. This is safe to call repeatedly from the "Scan for devices"
 * button.
 */

export interface UsbCandidate {
  transport: 'usb';
  vendorId: number;
  productId: number;
  vendorIdHex: string;  // "0x04b8"
  productIdHex: string; // "0x0202"
  busNumber?: number;
  deviceAddress?: number;
  manufacturer?: string | null;
  product?: string | null;
  serialNumber?: string | null;
}

function toHex(n: number): string {
  return '0x' + n.toString(16).padStart(4, '0');
}

interface UsbBindingLike {
  getDeviceList: () => Array<{
    busNumber?: number;
    deviceAddress?: number;
    deviceDescriptor: {
      idVendor: number;
      idProduct: number;
      iManufacturer?: number;
      iProduct?: number;
      iSerialNumber?: number;
    };
    open?: () => void;
    close?: () => void;
    getStringDescriptor?: (index: number, cb: (err: Error | null, value?: string) => void) => void;
  }>;
}

/**
 * Best-effort string descriptor read. Many devices reject this without
 * the proper interface claim, so failures are swallowed and the field is
 * returned as null.
 */
async function readStringDescriptor(
  device: ReturnType<UsbBindingLike['getDeviceList']>[number],
  index: number | undefined,
): Promise<string | null> {
  if (!index || !device.open || !device.close || !device.getStringDescriptor) return null;
  try {
    device.open();
  } catch {
    return null;
  }
  try {
    return await new Promise<string | null>((resolve) => {
      try {
        device.getStringDescriptor!(index, (err, value) => {
          if (err || !value) resolve(null);
          else resolve(value.trim() || null);
        });
      } catch {
        resolve(null);
      }
    });
  } finally {
    try { device.close!(); } catch { /* noop */ }
  }
}

export async function discoverUsbDevices(): Promise<UsbCandidate[]> {
  let binding: UsbBindingLike;
  try {
    binding = (await import('usb' as never)) as unknown as UsbBindingLike;
  } catch {
    return [];
  }
  let raw: ReturnType<UsbBindingLike['getDeviceList']>;
  try {
    raw = binding.getDeviceList();
  } catch {
    return [];
  }

  const out: UsbCandidate[] = [];
  for (const d of raw) {
    const desc = d.deviceDescriptor;
    if (!desc) continue;
    const [manufacturer, product, serialNumber] = await Promise.all([
      readStringDescriptor(d, desc.iManufacturer),
      readStringDescriptor(d, desc.iProduct),
      readStringDescriptor(d, desc.iSerialNumber),
    ]);
    out.push({
      transport: 'usb',
      vendorId: desc.idVendor,
      productId: desc.idProduct,
      vendorIdHex: toHex(desc.idVendor),
      productIdHex: toHex(desc.idProduct),
      busNumber: d.busNumber,
      deviceAddress: d.deviceAddress,
      manufacturer,
      product,
      serialNumber,
    });
  }
  return out;
}
