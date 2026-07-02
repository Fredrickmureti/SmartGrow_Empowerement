"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.UsbTransport = void 0;
exports.__setUsbBinding = __setUsbBinding;
let _binding = null;
function loadBinding() {
    if (_binding)
        return _binding;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const usb = require('usb');
    _binding = {
        getDeviceList: () => usb.getDeviceList(),
        findByIds: (vid, pid) => usb.findByIds(vid, pid),
    };
    return _binding;
}
/** Test seam. */
function __setUsbBinding(b) {
    _binding = b;
}
// Per-(vendor,product) mutex so two saga steps cannot claim the same
// device interface concurrently — claim() throws LIBUSB_ERROR_BUSY.
const MUTEXES = new Map();
function keyOf(t) { return `${t.vendorId}:${t.productId}`; }
async function withMutex(t, fn) {
    const key = keyOf(t);
    const prev = MUTEXES.get(key) ?? Promise.resolve();
    let release = () => { };
    const next = new Promise((res) => { release = res; });
    MUTEXES.set(key, next);
    try {
        await prev;
        return await fn();
    }
    finally {
        release();
    }
}
function pickOutEndpoint(iface) {
    return iface.endpoints.find((e) => e.direction === 'out') ?? null;
}
exports.UsbTransport = {
    list() {
        try {
            return loadBinding().getDeviceList().map((d) => ({
                vendorId: d.deviceDescriptor.idVendor,
                productId: d.deviceDescriptor.idProduct,
                manufacturer: d.deviceDescriptor.iManufacturer,
            }));
        }
        catch {
            return [];
        }
    },
    async send(target, bytes) {
        const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
        return withMutex(target, async () => {
            let device;
            let iface;
            try {
                device = loadBinding().findByIds(target.vendorId, target.productId);
                if (!device)
                    return { ok: false, error: 'device not found' };
                device.open();
                iface = device.interfaces?.[target.interfaceIndex ?? 0];
                if (!iface) {
                    device.close();
                    return { ok: false, error: 'no interface available' };
                }
                if (iface.isKernelDriverActive())
                    iface.detachKernelDriver();
                iface.claim();
                const out = pickOutEndpoint(iface);
                if (!out) {
                    await releaseAndClose(iface, device);
                    return { ok: false, error: 'no OUT endpoint' };
                }
                const timeout = target.timeoutMs ?? 5000;
                const result = await new Promise((resolve) => {
                    const timer = setTimeout(() => resolve({ ok: false, error: 'transfer timeout' }), timeout);
                    out.transfer(buf, (err) => {
                        clearTimeout(timer);
                        if (err)
                            resolve({ ok: false, error: err.message });
                        else
                            resolve({ ok: true, bytes: buf.length });
                    });
                });
                await releaseAndClose(iface, device);
                return result;
            }
            catch (err) {
                try {
                    if (iface && device)
                        await releaseAndClose(iface, device);
                }
                catch { /* noop */ }
                return { ok: false, error: err.message };
            }
        });
    },
    async test(target) {
        try {
            const device = loadBinding().findByIds(target.vendorId, target.productId);
            if (!device)
                return { ok: false, error: 'device not found' };
            device.open();
            const iface = device.interfaces?.[target.interfaceIndex ?? 0];
            if (!iface) {
                device.close();
                return { ok: false, error: 'no interface' };
            }
            device.close();
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err.message };
        }
    },
    isAvailable() {
        try {
            loadBinding();
            return true;
        }
        catch {
            return false;
        }
    },
    async disconnect(_target) {
        // node-usb is stateless across calls — claim/release happens per send.
    },
};
async function releaseAndClose(iface, device) {
    await new Promise((resolve) => iface.release(() => resolve()));
    try {
        device.close();
    }
    catch { /* already closed */ }
}
//# sourceMappingURL=UsbTransport.js.map