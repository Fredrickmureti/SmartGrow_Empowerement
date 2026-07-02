"use strict";
/**
 * SerialTransport — main-process serial-port owner.
 *
 * Wraps `serialport` with:
 *   • per-port async mutex so concurrent saga steps cannot interleave writes
 *     mid-frame on the same RS-232 line (the #1 cause of garbled receipts
 *     and corrupted scale frames on production POS stations).
 *   • connection cache so a scale opened by the renderer's `serial:connect`
 *     shim and a saga-driven `cash_drawer:open` share one physical handle.
 *   • bounded read buffer with subscriber fan-out for poll-style scales.
 *
 * `serialport` is required lazily so the renderer's vitest jsdom run never
 * loads the native binding. Tests inject a mock via `__setBinding`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SerialTransport = void 0;
exports.__setSerialBinding = __setSerialBinding;
const node_events_1 = require("node:events");
let _binding = null;
function loadBinding() {
    if (_binding)
        return _binding;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SerialPort } = require('serialport');
    _binding = {
        async list() {
            const ports = await SerialPort.list();
            return ports.map((p) => ({
                path: p.path,
                manufacturer: p.manufacturer,
                serialNumber: p.serialNumber,
                vendorId: p.vendorId,
                productId: p.productId,
            }));
        },
        open(opts) {
            // The serialport v12 constructor opens asynchronously; we surface
            // open errors via the 'error' event which write() awaits.
            const sp = new SerialPort({
                path: opts.path,
                baudRate: opts.baudRate,
                dataBits: opts.dataBits ?? 8,
                stopBits: opts.stopBits ?? 1,
                parity: opts.parity ?? 'none',
                autoOpen: true,
            });
            return sp;
        },
    };
    return _binding;
}
/** Test seam — call from vitest beforeEach to inject a fake binding. */
function __setSerialBinding(b) {
    _binding = b;
}
const POOL = new Map();
function keyOf(opts) {
    return `${opts.path}|${opts.baudRate}|${opts.dataBits ?? 8}|${opts.stopBits ?? 1}|${opts.parity ?? 'none'}`;
}
async function withMutex(entry, fn) {
    // Chain onto the entry's mutex so successive calls strictly serialise.
    const prev = entry.mutex;
    let release = () => { };
    entry.mutex = new Promise((res) => { release = res; });
    try {
        await prev;
        return await fn();
    }
    finally {
        release();
    }
}
function scheduleIdleClose(entry, key) {
    const idle = entry.opts.idleCloseMs ?? 0;
    if (!idle)
        return;
    if (entry.idleTimer)
        clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
        if (Date.now() - entry.lastUsed < idle)
            return;
        try {
            entry.handle.close();
        }
        catch { /* noop */ }
        POOL.delete(key);
    }, idle);
}
async function getOrOpen(opts) {
    const key = keyOf(opts);
    const existing = POOL.get(key);
    if (existing && existing.handle.isOpen)
        return existing;
    const binding = loadBinding();
    const handle = binding.open(opts);
    const bus = new node_events_1.EventEmitter();
    // Wait for 'open' OR error before treating the port as usable.
    await new Promise((resolve, reject) => {
        let settled = false;
        const onOpen = () => { if (settled)
            return; settled = true; cleanup(); resolve(); };
        const onErr = (err) => { if (settled)
            return; settled = true; cleanup(); reject(err); };
        const cleanup = () => {
            handle.removeListener('open', onOpen);
            handle.removeListener('error', onErr);
        };
        // serialport emits 'open' once even if `autoOpen: true` — and synchronously when mocked.
        if (handle.isOpen) {
            settled = true;
            resolve();
            return;
        }
        handle.once('open', onOpen);
        handle.once('error', onErr);
    });
    handle.on('data', (data) => bus.emit('data', data));
    handle.on('error', (err) => bus.emit('error', err));
    handle.on('close', () => { POOL.delete(key); bus.emit('close'); });
    const entry = {
        handle, opts, mutex: Promise.resolve(), bus,
        idleTimer: null, lastUsed: Date.now(),
    };
    POOL.set(key, entry);
    return entry;
}
exports.SerialTransport = {
    async list() {
        return loadBinding().list();
    },
    async send(opts, bytes) {
        const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
        try {
            const entry = await getOrOpen(opts);
            return await withMutex(entry, () => new Promise((resolve) => {
                entry.handle.write(buf, (err) => {
                    entry.lastUsed = Date.now();
                    scheduleIdleClose(entry, keyOf(opts));
                    if (err)
                        resolve({ ok: false, error: err.message });
                    else
                        resolve({ ok: true, bytes: buf.length });
                });
            }));
        }
        catch (err) {
            return { ok: false, error: err.message };
        }
    },
    /** Subscribe to incoming data for poll-style scales. Returns unsubscribe. */
    async subscribe(opts, onData) {
        const entry = await getOrOpen(opts);
        entry.bus.on('data', onData);
        return () => entry.bus.off('data', onData);
    },
    /** Test if the port can be opened. Closes on success. */
    async test(opts) {
        try {
            const entry = await getOrOpen(opts);
            // Touch lastUsed so the idle timer eventually closes it.
            entry.lastUsed = Date.now();
            scheduleIdleClose(entry, keyOf(opts));
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
    async disconnect(opts) {
        const key = keyOf(opts);
        const entry = POOL.get(key);
        if (!entry)
            return;
        if (entry.idleTimer)
            clearTimeout(entry.idleTimer);
        POOL.delete(key);
        await new Promise((resolve) => entry.handle.close(() => resolve()));
    },
    /** Test helper — drops the entire pool without touching real hardware. */
    _resetPool() {
        for (const [, entry] of POOL) {
            if (entry.idleTimer)
                clearTimeout(entry.idleTimer);
            try {
                entry.handle.close();
            }
            catch { /* noop */ }
        }
        POOL.clear();
    },
};
//# sourceMappingURL=SerialTransport.js.map