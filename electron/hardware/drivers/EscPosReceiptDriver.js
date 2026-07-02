"use strict";
/**
 * EscPosReceiptDriver — receipt printer over any byte-stream transport.
 *
 * Accepts `print_receipt` with either:
 *   - `payload.bytes: number[]` — pre-rendered ESC/POS byte stream
 *     (this is the production path; the renderer's receipt renderer emits
 *      bytes via the shared encoder)
 *   - `payload.text: string` — UTF-8 fallback; encoded raw with a final
 *     paper-cut sequence appended.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EscPosReceiptDriver = void 0;
const TransportDriver_1 = require("./TransportDriver");
const PAPER_CUT = Buffer.from([0x1D, 0x56, 0x00]); // GS V 0 — full cut
class EscPosReceiptDriver extends TransportDriver_1.TransportDriver {
    constructor() {
        super(...arguments);
        this.role = 'receipt_printer';
    }
    supportedOps() { return ['print_receipt']; }
    async handle(cmd) {
        if (cmd.op !== 'print_receipt') {
            return { ok: false, error: `unsupported op '${cmd.op}' on receipt_printer` };
        }
        const payload = (cmd.payload ?? {});
        let bytes = null;
        if (Array.isArray(payload.bytes)) {
            bytes = Buffer.from(payload.bytes);
        }
        else if (typeof payload.text === 'string' && payload.text.length > 0) {
            bytes = Buffer.concat([Buffer.from(payload.text, 'utf8'), payload.appendCut === false ? Buffer.alloc(0) : PAPER_CUT]);
        }
        if (!bytes || bytes.length === 0) {
            return { ok: false, error: 'print_receipt payload missing bytes/text' };
        }
        return this.send(bytes);
    }
}
exports.EscPosReceiptDriver = EscPosReceiptDriver;
//# sourceMappingURL=EscPosReceiptDriver.js.map