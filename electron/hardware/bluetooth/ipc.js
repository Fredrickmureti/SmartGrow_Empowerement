"use strict";
/**
 * Renderer-facing IPC helpers for the Bluetooth pairing manager.
 *
 * Track B-UI (2026-05-20). These are PURE async functions that take the
 * `BluetoothPairingManager` as an argument so they can be unit-tested
 * against an `InMemoryBtPairingsStore` + fake radio without spinning up
 * `ipcMain`. `electron/main.ts` thinly wraps each one as an
 * `ipcMain.handle('pos:bluetooth:*', ...)` callback.
 *
 * SECURITY INVARIANT — the renderer MUST NEVER see `link_key_plain`.
 * `BtPairingsStore.list()` returns hydrated rows (decrypted in main for
 * `radio.connect(mac, linkKey)` use), so this module strips that field
 * before crossing the IPC boundary. The compiler-enforced shape is
 * `SafeBtPairingRow` — there is no path that lets the plaintext escape.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ipcList = ipcList;
exports.ipcPair = ipcPair;
exports.ipcUnpair = ipcUnpair;
exports.ipcConnect = ipcConnect;
exports.ipcDisconnect = ipcDisconnect;
exports.ipcHealth = ipcHealth;
function sanitise(row, state) {
    // Explicit projection — adding fields to BtPairingRow upstream will NOT
    // automatically leak them into IPC. Reviewers must touch this file.
    return {
        device_id: row.device_id,
        mac: row.mac,
        name: row.name,
        role: row.role,
        auto_reconnect: row.auto_reconnect,
        paired_at: row.paired_at,
        last_connected_at: row.last_connected_at,
        state,
    };
}
function requireManager(get) {
    const m = get();
    if (!m)
        return { error: 'bluetooth manager not initialised' };
    return m;
}
async function ipcList(get) {
    const m = requireManager(get);
    if ('error' in m)
        return { ok: false, error: m.error };
    try {
        const rows = m.listPaired().map((r) => sanitise(r, m.getState(r.device_id)));
        return { ok: true, data: rows };
    }
    catch (err) {
        return { ok: false, error: err.message };
    }
}
async function ipcPair(get, input) {
    const m = requireManager(get);
    if ('error' in m)
        return { ok: false, error: m.error };
    if (!input?.deviceId || !input?.mac || !input?.role) {
        return { ok: false, error: 'deviceId, mac and role are required' };
    }
    try {
        const r = await m.pair({
            deviceId: String(input.deviceId),
            mac: String(input.mac),
            name: input.name ?? undefined,
            role: input.role,
            autoReconnect: input.autoReconnect,
        });
        return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'pair failed' };
    }
    catch (err) {
        return { ok: false, error: err.message };
    }
}
async function ipcUnpair(get, deviceId) {
    const m = requireManager(get);
    if ('error' in m)
        return { ok: false, error: m.error };
    if (!deviceId)
        return { ok: false, error: 'deviceId is required' };
    try {
        await m.unpair(String(deviceId));
        return { ok: true };
    }
    catch (err) {
        return { ok: false, error: err.message };
    }
}
async function ipcConnect(get, deviceId) {
    const m = requireManager(get);
    if ('error' in m)
        return { ok: false, error: m.error };
    if (!deviceId)
        return { ok: false, error: 'deviceId is required' };
    try {
        const r = await m.connect(String(deviceId));
        return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'connect failed' };
    }
    catch (err) {
        return { ok: false, error: err.message };
    }
}
async function ipcDisconnect(get, deviceId) {
    const m = requireManager(get);
    if ('error' in m)
        return { ok: false, error: m.error };
    if (!deviceId)
        return { ok: false, error: 'deviceId is required' };
    try {
        await m.disconnect(String(deviceId));
        return { ok: true };
    }
    catch (err) {
        return { ok: false, error: err.message };
    }
}
async function ipcHealth(get, deviceId) {
    const m = requireManager(get);
    if ('error' in m)
        return { ok: false, error: m.error };
    if (!deviceId)
        return { ok: false, error: 'deviceId is required' };
    try {
        const h = await m.healthCheck(String(deviceId));
        return { ok: true, data: { ok: h.ok, latencyMs: h.latencyMs, state: h.state, error: h.error } };
    }
    catch (err) {
        return { ok: false, error: err.message };
    }
}
//# sourceMappingURL=ipc.js.map