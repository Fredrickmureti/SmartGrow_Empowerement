/**
 * UsbTransport — main-process USB owner.
 *
 * Wraps `node-usb` with claim/release lifecycle, per-(vendor,product)
 * mutex, and a cross-platform interface-table for picking the OUT bulk
 * endpoint on classes other than 7 (printers). On Linux the kernel HID
 * driver must be detached before claim; on Windows libusb already owns
 * the device once WinUSB is installed; on macOS no detach is needed.
 *
 * `usb` is required lazily so the renderer's vitest jsdom run never
 * loads the native binding. Tests inject a mock via `__setBinding`.
 */

export interface UsbDeviceTarget {
  vendorId: number;
  productId: number;
  /** Optional interface index override (default: first interface). */
  interfaceIndex?: number;
  /** Per-call timeout in ms (default 5_000). */
  timeoutMs?: number;
}

export interface UsbSendResult {
  ok: boolean;
  bytes?: number;
  error?: string;
}

export interface UsbListedDevice {
  vendorId: number;
  productId: number;
  manufacturer?: number;
}

/** Bits of `node-usb` we use. */
export interface UsbBinding {
  getDeviceList(): UsbDeviceDescriptorWrapped[];
  findByIds(vid: number, pid: number): UsbDeviceWrapped | undefined;
}
export interface UsbDeviceDescriptorWrapped {
  deviceDescriptor: { idVendor: number; idProduct: number; iManufacturer: number };
}
export interface UsbDeviceWrapped {
  open(): void;
  close(): void;
  interfaces?: UsbInterfaceWrapped[] | null;
}
export interface UsbInterfaceWrapped {
  endpoints: UsbEndpointWrapped[];
  isKernelDriverActive(): boolean;
  detachKernelDriver(): void;
  claim(): void;
  release(cb: (err?: Error) => void): void;
}
export interface UsbEndpointWrapped {
  direction: 'in' | 'out';
  transfer(data: Buffer, cb: (err?: Error) => void): void;
}

let _binding: UsbBinding | null = null;

function loadBinding(): UsbBinding {
  if (_binding) return _binding;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const usb = require('usb') as typeof import('usb');
  _binding = {
    getDeviceList: () => usb.getDeviceList() as unknown as UsbDeviceDescriptorWrapped[],
    findByIds: (vid, pid) => usb.findByIds(vid, pid) as unknown as UsbDeviceWrapped | undefined,
  };
  return _binding;
}

/** Test seam. */
export function __setUsbBinding(b: UsbBinding | null): void {
  _binding = b;
}

// Per-(vendor,product) mutex so two saga steps cannot claim the same
// device interface concurrently — claim() throws LIBUSB_ERROR_BUSY.
const MUTEXES = new Map<string, Promise<void>>();
function keyOf(t: UsbDeviceTarget): string { return `${t.vendorId}:${t.productId}`; }

async function withMutex<T>(t: UsbDeviceTarget, fn: () => Promise<T>): Promise<T> {
  const key = keyOf(t);
  const prev = MUTEXES.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((res) => { release = res; });
  MUTEXES.set(key, next);
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

function pickOutEndpoint(iface: UsbInterfaceWrapped): UsbEndpointWrapped | null {
  return iface.endpoints.find((e) => e.direction === 'out') ?? null;
}

export const UsbTransport = {
  list(): UsbListedDevice[] {
    try {
      return loadBinding().getDeviceList().map((d) => ({
        vendorId: d.deviceDescriptor.idVendor,
        productId: d.deviceDescriptor.idProduct,
        manufacturer: d.deviceDescriptor.iManufacturer,
      }));
    } catch {
      return [];
    }
  },

  async send(target: UsbDeviceTarget, bytes: Buffer | number[]): Promise<UsbSendResult> {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return withMutex(target, async () => {
      let device: UsbDeviceWrapped | undefined;
      let iface: UsbInterfaceWrapped | undefined;
      try {
        device = loadBinding().findByIds(target.vendorId, target.productId);
        if (!device) return { ok: false, error: 'device not found' };
        device.open();
        iface = device.interfaces?.[target.interfaceIndex ?? 0];
        if (!iface) { device.close(); return { ok: false, error: 'no interface available' }; }
        if (iface.isKernelDriverActive()) iface.detachKernelDriver();
        iface.claim();
        const out = pickOutEndpoint(iface);
        if (!out) {
          await releaseAndClose(iface, device);
          return { ok: false, error: 'no OUT endpoint' };
        }
        const timeout = target.timeoutMs ?? 5_000;
        const result = await new Promise<UsbSendResult>((resolve) => {
          const timer = setTimeout(() => resolve({ ok: false, error: 'transfer timeout' }), timeout);
          out.transfer(buf, (err) => {
            clearTimeout(timer);
            if (err) resolve({ ok: false, error: err.message });
            else resolve({ ok: true, bytes: buf.length });
          });
        });
        await releaseAndClose(iface, device);
        return result;
      } catch (err) {
        try { if (iface && device) await releaseAndClose(iface, device); } catch { /* noop */ }
        return { ok: false, error: (err as Error).message };
      }
    });
  },

  async test(target: UsbDeviceTarget): Promise<{ ok: boolean; error?: string }> {
    try {
      const device = loadBinding().findByIds(target.vendorId, target.productId);
      if (!device) return { ok: false, error: 'device not found' };
      device.open();
      const iface = device.interfaces?.[target.interfaceIndex ?? 0];
      if (!iface) { device.close(); return { ok: false, error: 'no interface' }; }
      device.close();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  isAvailable(): boolean {
    try { loadBinding(); return true; } catch { return false; }
  },

  async disconnect(_target: UsbDeviceTarget): Promise<void> {
    // node-usb is stateless across calls — claim/release happens per send.
  },
};

async function releaseAndClose(iface: UsbInterfaceWrapped, device: UsbDeviceWrapped): Promise<void> {
  await new Promise<void>((resolve) => iface.release(() => resolve()));
  try { device.close(); } catch { /* already closed */ }
}
