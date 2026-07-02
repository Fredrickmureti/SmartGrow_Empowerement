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

import { TransportDriver } from './TransportDriver';
import type { ExecCommand, ExecResult, DeviceRole } from '../types';

const PAPER_CUT = Buffer.from([0x1D, 0x56, 0x00]); // GS V 0 — full cut

export class EscPosReceiptDriver extends TransportDriver {
  readonly role: DeviceRole = 'receipt_printer';

  // Audit Wave 9d.3: `print_raw` was missing — `hardwareClient.printRawBytes`
  // emits `receipt_printer:print_raw`, so the previous narrow op list made
  // server-rendered ESC/POS receipts unreachable in Electron.
  supportedOps(): readonly string[] { return ['print_receipt', 'print_raw']; }

  async handle(cmd: ExecCommand): Promise<ExecResult> {
    if (cmd.op !== 'print_receipt' && cmd.op !== 'print_raw') {
      return { ok: false, error: `unsupported op '${cmd.op}' on receipt_printer` };
    }
    const payload = (cmd.payload ?? {}) as { bytes?: number[] | Uint8Array; text?: string; appendCut?: boolean } | number[] | Uint8Array;
    let bytes: Buffer | null = null;
    // `print_raw` callers may pass a raw byte array directly as the payload
    // (matches `hardwareClient.printRawBytes(bytes)`'s wire shape).
    if (Array.isArray(payload) || payload instanceof Uint8Array) {
      bytes = Buffer.from(payload as ArrayLike<number>);
    } else if (Array.isArray((payload as { bytes?: unknown }).bytes) || (payload as { bytes?: unknown }).bytes instanceof Uint8Array) {
      bytes = Buffer.from((payload as { bytes: ArrayLike<number> }).bytes);
    } else if (typeof (payload as { text?: unknown }).text === 'string' && ((payload as { text: string }).text.length > 0)) {
      const p = payload as { text: string; appendCut?: boolean };
      bytes = Buffer.concat([Buffer.from(p.text, 'utf8'), p.appendCut === false ? Buffer.alloc(0) : PAPER_CUT]);
    }
    if (!bytes || bytes.length === 0) {
      return { ok: false, error: `${cmd.op} payload missing bytes/text` };
    }
    return this.send(bytes);
  }
}
