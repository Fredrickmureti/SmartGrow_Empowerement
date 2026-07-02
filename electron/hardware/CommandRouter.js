"use strict";
/**
 * CommandRouter — the only sanctioned IPC entry point for hardware operations.
 *
 * Registered in `electron/main.ts` as `ipcMain.handle('pos:exec', …)`.
 * Validates every payload against {@link ExecCommandSchema}, denies unknown
 * roles/ops, audits every call, and dispatches via a pluggable handler
 * registry so drivers can be moved into main one at a time without
 * touching the renderer.
 *
 * This file deliberately has zero `node-usb` / `serialport` imports so it
 * can be unit-tested in the Vitest jsdom environment alongside the
 * renderer tests.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.commandRouter = exports.CommandRouter = void 0;
exports.validateExecCommand = validateExecCommand;
/** Pure validator — avoids a Zod dep in the Electron bundle for now. */
function validateExecCommand(input) {
    if (!input || typeof input !== 'object')
        return { ok: false, error: 'payload must be an object' };
    const o = input;
    const allowedRoles = [
        'receipt_printer', 'kitchen_printer', 'cash_drawer', 'scale',
        'scanner', 'customer_display', 'payment_terminal', 'saga',
    ];
    if (typeof o.role !== 'string' || !allowedRoles.includes(o.role)) {
        return { ok: false, error: `invalid role: ${String(o.role)}` };
    }
    if (typeof o.op !== 'string' || o.op.length === 0 || o.op.length > 64) {
        return { ok: false, error: 'invalid op' };
    }
    if (typeof o.idempotencyKey !== 'string' || o.idempotencyKey.length < 8 || o.idempotencyKey.length > 128) {
        return { ok: false, error: 'invalid idempotencyKey' };
    }
    if (o.maxAttempts !== undefined) {
        if (typeof o.maxAttempts !== 'number' || o.maxAttempts < 1 || o.maxAttempts > 10) {
            return { ok: false, error: 'maxAttempts must be 1..10' };
        }
    }
    return {
        ok: true,
        cmd: {
            role: o.role,
            op: o.op,
            payload: o.payload,
            idempotencyKey: o.idempotencyKey,
            maxAttempts: o.maxAttempts,
        },
    };
}
/** Registry of `role:op` → handler. */
class CommandRouter {
    constructor(opts) {
        this.handlers = new Map();
        this.audit = opts?.audit;
    }
    /** Register a handler for a `role:op` pair. Throws on duplicate registration. */
    register(role, op, handler) {
        const key = `${role}:${op}`;
        if (this.handlers.has(key)) {
            throw new Error(`CommandRouter: duplicate handler for ${key}`);
        }
        this.handlers.set(key, handler);
    }
    hasHandler(role, op) {
        return this.handlers.has(`${role}:${op}`);
    }
    async exec(rawInput) {
        const parsed = validateExecCommand(rawInput);
        if (parsed.ok === false)
            return { ok: false, error: parsed.error };
        const cmd = parsed.cmd;
        const handler = this.handlers.get(`${cmd.role}:${cmd.op}`);
        if (!handler) {
            const res = { ok: false, error: `unknown op: ${cmd.role}:${cmd.op}` };
            this.audit?.(cmd, res);
            return res;
        }
        try {
            const res = await handler(cmd);
            this.audit?.(cmd, res);
            return res;
        }
        catch (err) {
            const res = { ok: false, error: err.message };
            this.audit?.(cmd, res);
            return res;
        }
    }
    /** Test helper: clear all registrations. */
    _reset() { this.handlers.clear(); }
}
exports.CommandRouter = CommandRouter;
/** Process-wide singleton used by `ipcMain.handle('pos:exec', …)`. */
exports.commandRouter = new CommandRouter();
//# sourceMappingURL=CommandRouter.js.map