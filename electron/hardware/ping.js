"use strict";
/**
 * ping.ts — Per-transport liveness probe for DeviceManager's health loop.
 *
 * Industry-aligned approach (Square Terminal SDK, Toast printer monitor):
 *   • Non-destructive: never writes data bytes, never triggers a print.
 *   • Bounded: each probe has its own short timeout (~500ms target,
 *     1.5s ceiling) so a hung device cannot stall the loop.
 *   • Per-(role, transport) dispatch — transport-specific failure modes
 *     surface as `lastError` for operator triage in the device card.
 *
 * Uses transports' existing `test()` / `testConnect()` primitives so the
 * ping path shares the same code path that the registration UI's
 * "Test Connection" button already exercises in the field.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.pingAssignment = pingAssignment;
const NetworkTransport_1 = require("./transports/NetworkTransport");
const UsbTransport_1 = require("./transports/UsbTransport");
const SerialTransport_1 = require("./transports/SerialTransport");
const CupsTransport_1 = require("./transports/CupsTransport");
const WinSpoolerTransport_1 = require("./transports/WinSpoolerTransport");
function cfgOf(a) {
    return (a.config && typeof a.config === 'object') ? a.config : {};
}
/**
 * Probe an assignment's device. Always returns within ~1.5s; never throws.
 */
async function pingAssignment(a) {
    const cfg = cfgOf(a);
    const started = Date.now();
    try {
        switch (a.transport) {
            case 'network': {
                const host = String(cfg.host ?? cfg.ipAddress ?? '');
                const port = Number(cfg.port ?? 9100);
                if (!host)
                    return { ok: false, latencyMs: 0, error: 'missing host' };
                const r = await NetworkTransport_1.NetworkTransport.testConnect({ host, port, timeoutMs: 1500 });
                return r.ok
                    ? { ok: true, latencyMs: r.latencyMs }
                    : { ok: false, latencyMs: Date.now() - started, error: r.error };
            }
            case 'usb': {
                const vendorId = Number(cfg.vendorId);
                const productId = Number(cfg.productId);
                if (!Number.isFinite(vendorId) || !Number.isFinite(productId)) {
                    return { ok: false, latencyMs: 0, error: 'missing vendorId/productId' };
                }
                const r = await UsbTransport_1.UsbTransport.test({
                    vendorId,
                    productId,
                    interfaceIndex: cfg.interfaceIndex,
                });
                return r.ok
                    ? { ok: true, latencyMs: Date.now() - started }
                    : { ok: false, latencyMs: Date.now() - started, error: r.error };
            }
            case 'serial': {
                const path = String(cfg.path ?? cfg.port ?? '');
                const baudRate = Number(cfg.baudRate ?? 9600);
                if (!path)
                    return { ok: false, latencyMs: 0, error: 'missing path' };
                const r = await SerialTransport_1.SerialTransport.test({
                    path,
                    baudRate,
                    dataBits: cfg.dataBits,
                    stopBits: cfg.stopBits,
                    parity: cfg.parity,
                });
                return r.ok
                    ? { ok: true, latencyMs: Date.now() - started }
                    : { ok: false, latencyMs: Date.now() - started, error: r.error };
            }
            case 'cups': {
                const queue = String(cfg.queue ?? '');
                if (!queue)
                    return { ok: false, latencyMs: 0, error: 'missing queue' };
                const r = await CupsTransport_1.CupsTransport.test({ queue });
                return r.ok
                    ? { ok: true, latencyMs: Date.now() - started }
                    : { ok: false, latencyMs: Date.now() - started, error: r.error };
            }
            case 'winspool': {
                const printer = String(cfg.printer ?? '');
                if (!printer)
                    return { ok: false, latencyMs: 0, error: 'missing printer' };
                const r = await WinSpoolerTransport_1.WinSpoolerTransport.test({ printer });
                return r.ok
                    ? { ok: true, latencyMs: Date.now() - started }
                    : { ok: false, latencyMs: Date.now() - started, error: r.error };
            }
            case 'bluetooth':
                {
                    const deviceId = String(cfg.deviceId ?? cfg.device_id ?? '');
                    if (!deviceId)
                        return { ok: false, latencyMs: 0, error: 'missing deviceId' };
                    // Lazy import to avoid a require cycle (bluetooth/index → transport → ping).
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { getBluetoothPairingManager } = require('./bluetooth');
                    const mgr = getBluetoothPairingManager();
                    if (!mgr)
                        return { ok: false, latencyMs: 0, error: 'bluetooth manager not initialised' };
                    const h = await mgr.healthCheck(deviceId);
                    return { ok: h.ok, latencyMs: h.latencyMs ?? Date.now() - started, error: h.error };
                }
            case 'browser':
                // Browser-side device is owned by the renderer; main has no probe.
                return { ok: true, latencyMs: 0 };
            default:
                return { ok: false, latencyMs: 0, error: `unknown transport ${String(a.transport)}` };
        }
    }
    catch (err) {
        return { ok: false, latencyMs: Date.now() - started, error: err.message };
    }
}
//# sourceMappingURL=ping.js.map