/**
 * EscPosKitchenDriver — kitchen-printer variant.
 *
 * Audit Wave 9d.8: kitchen op vocabulary collapses to a single canonical
 * name `print_receipt` (same shape as `receipt_printer:print_receipt` so
 * the saga & PrintClient stay symmetrical). Legacy `print_ticket` callers
 * keep working because `handlers/index.ts` aliases the IPC key to this
 * driver's `print_receipt` handler. The driver itself only advertises the
 * canonical op so future drift cannot reintroduce a mismatch.
 */

import { TransportDriver } from './TransportDriver';
import type { ExecCommand, ExecResult, DeviceRole } from '../types';

const PAPER_CUT = Buffer.from([0x1D, 0x56, 0x00]);
const BELL = Buffer.from([0x07]);

export class EscPosKitchenDriver extends TransportDriver {
  readonly role: DeviceRole = 'kitchen_printer';
  supportedOps(): readonly string[] { return ['print_receipt']; }

  async handle(cmd: ExecCommand): Promise<ExecResult> {
    if (cmd.op !== 'print_receipt') {
      return { ok: false, error: `unsupported op '${cmd.op}' on kitchen_printer` };
    }
    const payload = (cmd.payload ?? {}) as { bytes?: number[] | Uint8Array; text?: string; bell?: boolean };
    const body: Buffer = (Array.isArray(payload.bytes) || payload.bytes instanceof Uint8Array)
      ? Buffer.from(payload.bytes as ArrayLike<number>)
      : Buffer.from(payload.text ?? '', 'utf8');
    if (body.length === 0) return { ok: false, error: `${cmd.op} payload missing bytes/text` };
    const parts = [payload.bell === false ? Buffer.alloc(0) : BELL, body, PAPER_CUT];
    return this.send(Buffer.concat(parts));
  }
}
