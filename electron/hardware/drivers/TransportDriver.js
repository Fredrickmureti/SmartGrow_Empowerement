"use strict";
/**
 * TransportDriver — shared byte-stream dispatch for drivers that just push
 * ESC/POS (or any opaque byte stream) over a configured transport.
 *
 * Consolidates the `sendBytes()` switch that previously lived in
 * `handlers/index.ts`. Receipt / kitchen / cash-drawer / customer-display
 * drivers all derive from this; they differ only in the bytes they build
 * and the ops they advertise.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransportDriver = void 0;
const IDriver_1 = require("./IDriver");
const NetworkTransport_1 = require("../transports/NetworkTransport");
const UsbTransport_1 = require("../transports/UsbTransport");
const SerialTransport_1 = require("../transports/SerialTransport");
const CupsTransport_1 = require("../transports/CupsTransport");
const WinSpoolerTransport_1 = require("../transports/WinSpoolerTransport");
class TransportDriver extends IDriver_1.BaseDriver {
    constructor(assignment) {
        super();
        this.assignment = assignment;
    }
    cfg() {
        return (this.assignment.config && typeof this.assignment.config === 'object')
            ? this.assignment.config
            : {};
    }
    /** Push raw bytes through the assignment's transport. */
    async send(bytes) {
        const a = this.assignment;
        const cfg = this.cfg();
        switch (a.transport) {
            case 'network': {
                const host = String(cfg.host ?? cfg.ipAddress ?? '');
                const port = Number(cfg.port ?? 9100);
                if (!host)
                    return { ok: false, error: 'network transport missing host' };
                const r = await NetworkTransport_1.NetworkTransport.rawSend({ host, port, timeoutMs: Number(cfg.timeoutMs ?? 5000) }, bytes);
                return r.ok
                    ? { ok: true, result: { bytes: r.bytes, transport: 'network' } }
                    : { ok: false, error: r.error };
            }
            case 'usb': {
                const vendorId = Number(cfg.vendorId);
                const productId = Number(cfg.productId);
                if (!Number.isFinite(vendorId) || !Number.isFinite(productId)) {
                    return { ok: false, error: 'usb transport missing vendorId/productId' };
                }
                const r = await UsbTransport_1.UsbTransport.send({ vendorId, productId, interfaceIndex: cfg.interfaceIndex, timeoutMs: cfg.timeoutMs }, bytes);
                return r.ok
                    ? { ok: true, result: { bytes: r.bytes, transport: 'usb' } }
                    : { ok: false, error: r.error ?? 'usb send failed' };
            }
            case 'serial': {
                const path = String(cfg.path ?? cfg.port ?? '');
                const baudRate = Number(cfg.baudRate ?? 9600);
                if (!path)
                    return { ok: false, error: 'serial transport missing path' };
                const r = await SerialTransport_1.SerialTransport.send({
                    path, baudRate,
                    dataBits: cfg.dataBits,
                    stopBits: cfg.stopBits,
                    parity: cfg.parity,
                    idleCloseMs: cfg.idleCloseMs,
                }, bytes);
                return r.ok
                    ? { ok: true, result: { bytes: r.bytes, transport: 'serial' } }
                    : { ok: false, error: r.error ?? 'serial send failed' };
            }
            case 'cups': {
                const queue = String(cfg.queue ?? '');
                if (!queue)
                    return { ok: false, error: 'cups transport missing queue' };
                const r = await CupsTransport_1.CupsTransport.send({ queue, timeoutMs: cfg.timeoutMs }, bytes);
                return r.ok ? { ok: true, result: { bytes: r.bytes, transport: 'cups' } } : { ok: false, error: r.error ?? 'cups send failed' };
            }
            case 'winspool': {
                const printer = String(cfg.printer ?? '');
                if (!printer)
                    return { ok: false, error: 'winspool transport missing printer' };
                const r = await WinSpoolerTransport_1.WinSpoolerTransport.send({ printer, timeoutMs: cfg.timeoutMs }, bytes);
                return r.ok ? { ok: true, result: { bytes: r.bytes, transport: 'winspool' } } : { ok: false, error: r.error ?? 'winspool send failed' };
            }
            case 'bluetooth': {
                // Lazy-import so the renderer test harness doesn't pull `noble`.
                const { BluetoothTransport } = await Promise.resolve().then(() => __importStar(require('../transports/BluetoothTransport')));
                const r = await BluetoothTransport.send({ deviceId: String(cfg.deviceId ?? cfg.mac ?? ''), serviceUuid: cfg.serviceUuid, characteristicUuid: cfg.characteristicUuid }, bytes);
                return r.ok ? { ok: true, result: { bytes: r.bytes, transport: 'bluetooth' } } : { ok: false, error: r.error ?? 'bluetooth send failed' };
            }
            case 'browser':
                return { ok: false, error: 'browser transport is renderer-side; main process must not dispatch it' };
            default:
                return { ok: false, error: `transport '${a.transport}' is unsupported` };
        }
    }
    /** Default ping uses the existing `ping.ts` helpers via dynamic import to avoid cycle. */
    async onHealthCheck() {
        const { pingAssignment } = await Promise.resolve().then(() => __importStar(require('../ping')));
        const r = await pingAssignment(this.assignment);
        return { ok: r.ok, latencyMs: r.latencyMs, error: r.error };
    }
    // BaseDriver expects state(); inherits implementation.
    state() { return this._state; }
}
exports.TransportDriver = TransportDriver;
//# sourceMappingURL=TransportDriver.js.map