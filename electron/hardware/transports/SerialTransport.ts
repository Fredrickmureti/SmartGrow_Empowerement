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

import { EventEmitter } from 'node:events';

export interface SerialOpenOptions {
  path: string;
  baudRate: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 1.5 | 2;
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
  /** Idle ms after which the cached handle is closed. 0 = keep-alive. */
  idleCloseMs?: number;
}

export interface SerialSendResult {
  ok: boolean;
  bytes?: number;
  error?: string;
}

export interface SerialListedPort {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

/** Narrow contract over the bits of `serialport` we actually use. */
export interface SerialPortBinding {
  list(): Promise<SerialListedPort[]>;
  open(opts: SerialOpenOptions): SerialPortHandle;
}
export interface SerialPortHandle extends EventEmitter {
  isOpen: boolean;
  write(buf: Buffer, cb: (err: Error | null | undefined) => void): boolean;
  close(cb?: (err?: Error | null) => void): void;
}

let _binding: SerialPortBinding | null = null;

function loadBinding(): SerialPortBinding {
  if (_binding) return _binding;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SerialPort } = require('serialport') as typeof import('serialport');
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
      return sp as unknown as SerialPortHandle;
    },
  };
  return _binding;
}

/** Test seam — call from vitest beforeEach to inject a fake binding. */
export function __setSerialBinding(b: SerialPortBinding | null): void {
  _binding = b;
}

interface PortEntry {
  handle: SerialPortHandle;
  opts: SerialOpenOptions;
  mutex: Promise<void>;
  bus: EventEmitter;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastUsed: number;
}

const POOL = new Map<string, PortEntry>();

function keyOf(opts: SerialOpenOptions): string {
  return `${opts.path}|${opts.baudRate}|${opts.dataBits ?? 8}|${opts.stopBits ?? 1}|${opts.parity ?? 'none'}`;
}

async function withMutex<T>(entry: PortEntry, fn: () => Promise<T>): Promise<T> {
  // Chain onto the entry's mutex so successive calls strictly serialise.
  const prev = entry.mutex;
  let release: () => void = () => {};
  entry.mutex = new Promise<void>((res) => { release = res; });
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

function scheduleIdleClose(entry: PortEntry, key: string): void {
  const idle = entry.opts.idleCloseMs ?? 0;
  if (!idle) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (Date.now() - entry.lastUsed < idle) return;
    try { entry.handle.close(); } catch { /* noop */ }
    POOL.delete(key);
  }, idle);
}

// Wave 12 C3 — open timeout in ms. Some USB-serial adapters never emit
// 'open' or 'error' if the underlying device disappears mid-enumeration;
// without a bound here a saga step would hang the queue forever.
const OPEN_TIMEOUT_MS = 5000;

async function getOrOpen(opts: SerialOpenOptions): Promise<PortEntry> {
  const key = keyOf(opts);
  const existing = POOL.get(key);
  if (existing && existing.handle.isOpen) return existing;
  const binding = loadBinding();
  const handle = binding.open(opts);
  const bus = new EventEmitter();
  // Wait for 'open' OR error before treating the port as usable.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      try { handle.close(); } catch { /* noop */ }
      reject(new Error(`SerialTransport: open timed out after ${OPEN_TIMEOUT_MS}ms (${opts.path})`));
    }, OPEN_TIMEOUT_MS);
    const onOpen = () => { if (settled) return; settled = true; clearTimeout(timer); cleanup(); resolve(); };
    const onErr = (err: Error) => { if (settled) return; settled = true; clearTimeout(timer); cleanup(); reject(err); };
    const cleanup = () => {
      handle.removeListener('open', onOpen);
      handle.removeListener('error', onErr);
    };
    // serialport emits 'open' once even if `autoOpen: true` — and synchronously when mocked.
    if (handle.isOpen) { settled = true; clearTimeout(timer); resolve(); return; }
    handle.once('open', onOpen);
    handle.once('error', onErr);
  });
  handle.on('data', (data: Buffer) => bus.emit('data', data));
  handle.on('error', (err: Error) => bus.emit('error', err));
  handle.on('close', () => { POOL.delete(key); bus.emit('close'); });
  const entry: PortEntry = {
    handle, opts, mutex: Promise.resolve(), bus,
    idleTimer: null, lastUsed: Date.now(),
  };
  POOL.set(key, entry);
  return entry;
}

export const SerialTransport = {
  async list(): Promise<SerialListedPort[]> {
    return loadBinding().list();
  },

  async send(opts: SerialOpenOptions, bytes: Buffer | number[]): Promise<SerialSendResult> {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    try {
      const entry = await getOrOpen(opts);
      return await withMutex(entry, () => new Promise<SerialSendResult>((resolve) => {
        entry.handle.write(buf, (err) => {
          entry.lastUsed = Date.now();
          scheduleIdleClose(entry, keyOf(opts));
          if (err) resolve({ ok: false, error: err.message });
          else resolve({ ok: true, bytes: buf.length });
        });
      }));
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  /** Subscribe to incoming data for poll-style scales. Returns unsubscribe. */
  async subscribe(opts: SerialOpenOptions, onData: (b: Buffer) => void): Promise<() => void> {
    const entry = await getOrOpen(opts);
    entry.bus.on('data', onData);
    return () => entry.bus.off('data', onData);
  },

  /** Test if the port can be opened. Closes on success. */
  async test(opts: SerialOpenOptions): Promise<{ ok: boolean; error?: string }> {
    try {
      const entry = await getOrOpen(opts);
      // Touch lastUsed so the idle timer eventually closes it.
      entry.lastUsed = Date.now();
      scheduleIdleClose(entry, keyOf(opts));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  isAvailable(): boolean {
    try { loadBinding(); return true; } catch { return false; }
  },

  async disconnect(opts: SerialOpenOptions): Promise<void> {
    const key = keyOf(opts);
    const entry = POOL.get(key);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    POOL.delete(key);
    await new Promise<void>((resolve) => entry.handle.close(() => resolve()));
  },

  /** Test helper — drops the entire pool without touching real hardware. */
  _resetPool(): void {
    for (const [, entry] of POOL) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      try { entry.handle.close(); } catch { /* noop */ }
    }
    POOL.clear();
  },
};
