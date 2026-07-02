/**
 * BluetoothTransport — lazy-loads `noble` at first use so the main
 * process never crashes when the native build is missing or the host
 * has no Bluetooth radio. All actual pairing + reconnect orchestration
 * lives in `electron/hardware/bluetooth/BluetoothPairingManager`; this
 * file is the byte-level transport only.
 */

import { getBluetoothPairingManager } from '../bluetooth';

export interface BluetoothTarget {
  deviceId: string;
  serviceUuid?: string;
  characteristicUuid?: string;
}

export interface BluetoothSendResult {
  ok: boolean;
  bytes?: number;
  error?: string;
}

/** Loader seam — overridable by tests via {@link __setNobleLoader}. */
let nobleLoader: () => unknown = () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('noble');
};

/** @internal — tests only. */
export function __setNobleLoader(loader: () => unknown): void {
  nobleLoader = loader;
}

function loadNoble(): { ok: true; noble: unknown } | { ok: false; error: string } {
  try {
    const n = nobleLoader();
    if (!n) return { ok: false, error: 'bluetooth radio unavailable (noble not installed)' };
    return { ok: true, noble: n };
  } catch (err) {
    return { ok: false, error: `bluetooth radio unavailable (${(err as Error).message})` };
  }
}

export const BluetoothTransport = {
  async send(target: BluetoothTarget, bytes: Buffer): Promise<BluetoothSendResult> {
    const mgr = getBluetoothPairingManager();
    if (!mgr) return { ok: false, error: 'bluetooth pairing manager not initialised' };
    const state = mgr.getState(target.deviceId);
    if (state !== 'connected') {
      // Drive the FSM to reconnect; the caller's queue retry will pick up.
      const r = await mgr.connect(target.deviceId);
      if (!r.ok) return { ok: false, error: r.error ?? 'not connected' };
    }
    const loaded = loadNoble();
    if (loaded.ok !== true) return { ok: false, error: loaded.error };
    // Concrete GATT write is vendor-specific; we surface a clear error
    // until a vendor adapter (Star/Epson Bluetooth printers) is wired.
    return { ok: false, error: 'bluetooth GATT write requires vendor adapter (Star/Epson BT printer)', bytes: bytes.length };
  },
  async test(target: BluetoothTarget): Promise<{ ok: boolean; error?: string }> {
    const mgr = getBluetoothPairingManager();
    if (!mgr) return { ok: false, error: 'bluetooth pairing manager not initialised' };
    const h = await mgr.healthCheck(target.deviceId);
    return { ok: h.ok, error: h.error };
  },
};
