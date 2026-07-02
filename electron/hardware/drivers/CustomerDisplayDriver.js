"use strict";
/**
 * CustomerDisplayDriver — 2x20 VFD / line-display.
 *
 * Accepts `update` with either `lines: string[]` (preferred) or
 * `bytes: number[]` (raw escape sequence for VFD models with custom
 * cursor positioning). For `lines`, we format as a clear-then-print
 * sequence using the broadly-supported ESC/POS line-display subset:
 *   - 0x0C — clear display
 *   - line 1 text + 0x0A
 *   - line 2 text
 *
 * `show_complete` ("Thank you!" splash) and `reset` are convenience ops.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomerDisplayDriver = void 0;
const TransportDriver_1 = require("./TransportDriver");
const CLEAR = Buffer.from([0x0C]);
const LF = Buffer.from([0x0A]);
function pad(line, width = 20) {
    if (line.length >= width)
        return line.slice(0, width);
    return line.padEnd(width, ' ');
}
function frameLines(lines) {
    const safe = lines.slice(0, 2).map((l) => pad(l ?? '', 20));
    if (safe.length === 1)
        safe.push(' '.repeat(20));
    return Buffer.concat([CLEAR, Buffer.from(safe[0], 'ascii'), LF, Buffer.from(safe[1], 'ascii')]);
}
class CustomerDisplayDriver extends TransportDriver_1.TransportDriver {
    constructor() {
        super(...arguments);
        this.role = 'customer_display';
    }
    supportedOps() { return ['update', 'show_complete', 'reset']; }
    async handle(cmd) {
        switch (cmd.op) {
            case 'update': {
                const payload = (cmd.payload ?? {});
                if (Array.isArray(payload.bytes))
                    return this.send(Buffer.from(payload.bytes));
                if (Array.isArray(payload.lines))
                    return this.send(frameLines(payload.lines));
                return { ok: false, error: 'update payload missing lines/bytes' };
            }
            case 'show_complete': {
                const payload = (cmd.payload ?? {});
                const msg = (payload.message ?? 'Thank you!').slice(0, 20);
                return this.send(frameLines([msg, 'Have a nice day']));
            }
            case 'reset':
                return this.send(CLEAR);
            default:
                return { ok: false, error: `unsupported op '${cmd.op}' on customer_display` };
        }
    }
}
exports.CustomerDisplayDriver = CustomerDisplayDriver;
//# sourceMappingURL=CustomerDisplayDriver.js.map