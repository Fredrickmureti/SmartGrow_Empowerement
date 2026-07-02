"use strict";
/**
 * MockDriver — deterministic in-memory driver for tests and dev fallback.
 *
 * Records every `handle()` call so tests can assert dispatch order and
 * payload shape. `connect/disconnect/healthCheck` always succeed.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockDriver = void 0;
const IDriver_1 = require("./IDriver");
class MockDriver extends IDriver_1.BaseDriver {
    constructor(role, ops = ['*']) {
        super();
        this.handled = [];
        this.role = role;
        this.ops = ops;
    }
    supportedOps() { return this.ops; }
    async onHealthCheck() {
        return { ok: true, latencyMs: 0 };
    }
    async handle(cmd) {
        this.handled.push({ op: cmd.op, payload: cmd.payload, idempotencyKey: cmd.idempotencyKey, at: Date.now() });
        return { ok: true, result: { mock: true, op: cmd.op } };
    }
}
exports.MockDriver = MockDriver;
//# sourceMappingURL=MockDriver.js.map