/**
 * EscPosLabelDriver — label printer over a byte-stream transport.
 *
 * Audit Wave 9d.3: `label_printer` was previously unreachable end-to-end
 * (CommandRouter rejected the role, buildDriver had no case, the queue
 * tick loop did not include it). This driver lands the thermal-label
 * variant first; a dedicated ZPL/EPL renderer ships in a follow-up loop
 * (audit P0 task #2). For now we accept opaque pre-rendered bytes
 * (`print_raw`) and a transitional ESC/POS thermal-receipt fallback
 * (`print_receipt`) so receipt-style label printers (most 80mm thermals
 * sold as "label printers") work out of the box.
 *
 * Future: split into `EscPosLabelDriver` vs `ZplLabelDriver` vs
 * `EplLabelDriver` once the renderer registers driver_type properly. The
 * caller-facing role (`label_printer`) stays stable across all three.
 */

import { TransportDriver } from './TransportDriver';
import type { ExecCommand, ExecResult, DeviceRole } from '../types';

const PAPER_CUT = Buffer.from([0x1D, 0x56, 0x00]); // GS V 0 — full cut

export class EscPosLabelDriver extends TransportDriver {
  readonly role: DeviceRole = 'label_printer';

  supportedOps(): readonly string[] { return ['print_raw', 'print_receipt', 'print_label']; }

  async handle(cmd: ExecCommand): Promise<ExecResult> {
    if (cmd.op !== 'print_raw' && cmd.op !== 'print_receipt' && cmd.op !== 'print_label') {
      return { ok: false, error: `unsupported op '${cmd.op}' on label_printer` };
    }
    const payload = (cmd.payload ?? {}) as { bytes?: number[] | Uint8Array; text?: string; appendCut?: boolean };
    let bytes: Buffer | null = null;
    if (Array.isArray(payload.bytes) || payload.bytes instanceof Uint8Array) {
      bytes = Buffer.from(payload.bytes as ArrayLike<number>);
    } else if (typeof payload.text === 'string' && payload.text.length > 0) {
      bytes = Buffer.concat([
        Buffer.from(payload.text, 'utf8'),
        payload.appendCut === false ? Buffer.alloc(0) : PAPER_CUT,
      ]);
    }
    if (!bytes || bytes.length === 0) {
      return { ok: false, error: `${cmd.op} payload missing bytes/text` };
    }
    return this.send(bytes);
  }
}
