"use strict";
/**
 * BluetoothTransport — lazy-loads `noble` at first use so the main
 * process never crashes when the native build is missing or the host
 * has no Bluetooth radio. All actual pairing + reconnect orchestration
 * lives in `electron/hardware/bluetooth/BluetoothPairingManager`; this
 * file is the byte-level transport only.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BluetoothTransport = void 0;
exports.__setNobleLoader = __setNobleLoader;
const bluetooth_1 = require("../bluetooth");
/** Loader seam — overridable by tests via {@link __setNobleLoader}. */
let nobleLoader = () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('noble');
};
/** @internal — tests only. */
function __setNobleLoader(loader) {
    nobleLoader = loader;
}
function loadNoble() {
    try {
        const n = nobleLoader();
        if (!n)
            return { ok: false, error: 'bluetooth radio unavailable (noble not installed)' };
        return { ok: true, noble: n };
    }
    catch (err) {
        return { ok: false, error: `bluetooth radio unavailable (${err.message})` };
    }
}
exports.BluetoothTransport = {
    async send(target, bytes) {
        const mgr = (0, bluetooth_1.getBluetoothPairingManager)();
        if (!mgr)
            return { ok: false, error: 'bluetooth pairing manager not initialised' };
        const state = mgr.getState(target.deviceId);
        if (state !== 'connected') {
            // Drive the FSM to reconnect; the caller's queue retry will pick up.
            const r = await mgr.connect(target.deviceId);
            if (!r.ok)
                return { ok: false, error: r.error ?? 'not connected' };
        }
        const loaded = loadNoble();
        if (loaded.ok !== true)
            return { ok: false, error: loaded.error };
        // Concrete GATT write is vendor-specific; we surface a clear error
        // until a vendor adapter (Star/Epson Bluetooth printers) is wired.
        return { ok: false, error: 'bluetooth GATT write requires vendor adapter (Star/Epson BT printer)', bytes: bytes.length };
    },
    async test(target) {
        const mgr = (0, bluetooth_1.getBluetoothPairingManager)();
        if (!mgr)
            return { ok: false, error: 'bluetooth pairing manager not initialised' };
        const h = await mgr.healthCheck(target.deviceId);
        return { ok: h.ok, error: h.error };
    },
};
//# sourceMappingURL=BluetoothTransport.js.map