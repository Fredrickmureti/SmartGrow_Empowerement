"use strict";
/**
 * EscPosKitchenDriver — kitchen-printer variant. Same byte-stream shape
 * as receipts; separated as its own driver so a future loop can attach
 * kitchen-specific formatting (item-station routing, bell character on
 * the first line, font-size doubling for line items) without touching
 * the receipt path.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EscPosKitchenDriver = void 0;
const TransportDriver_1 = require("./TransportDriver");
const PAPER_CUT = Buffer.from([0x1D, 0x56, 0x00]);
const BELL = Buffer.from([0x07]); // BEL — most ESC/POS printers chime briefly
class EscPosKitchenDriver extends TransportDriver_1.TransportDriver {
    constructor() {
        super(...arguments);
        this.role = 'kitchen_printer';
    }
    supportedOps() { return ['print_ticket']; }
    async handle(cmd) {
        if (cmd.op !== 'print_ticket') {
            return { ok: false, error: `unsupported op '${cmd.op}' on kitchen_printer` };
        }
        const payload = (cmd.payload ?? {});
        const body = Array.isArray(payload.bytes)
            ? Buffer.from(payload.bytes)
            : Buffer.from(payload.text ?? '', 'utf8');
        if (body.length === 0)
            return { ok: false, error: 'print_ticket payload missing bytes/text' };
        const parts = [payload.bell === false ? Buffer.alloc(0) : BELL, body, PAPER_CUT];
        return this.send(Buffer.concat(parts));
    }
}
exports.EscPosKitchenDriver = EscPosKitchenDriver;
//# sourceMappingURL=EscPosKitchenDriver.js.map