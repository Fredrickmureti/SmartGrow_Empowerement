/**
 * EplLabelDriver — Eltron EPL2 label driver.
 *
 * Audit Wave 9d.8 (P0 #2) + ADR-0086 / D6. Pure transport for pre-rendered
 * EPL2. Older Zebra/Eltron LP/TLP-class printers speak EPL2 (line-oriented
 * ASCII, no `^XA…^XZ` envelope). Modern Zebra firmware can be set to EPL
 * or ZPL; this driver targets the EPL setting.
 *
 * Layout MUST come from `label_templates` (engine=`epl`) — the driver does
 * not own a `LabelSpec` and does not synthesise `A<x>,<y>` / `B<x>,<y>`
 * lines. Both ops (`print_raw`, `print_label`) accept a pre-rendered
 * `{ bytes | epl }` payload and pass through.
 */
import { TransportDriver } from './TransportDriver';
import type { ExecCommand, ExecResult, DeviceRole } from '../types';

export class EplLabelDriver extends TransportDriver {
  readonly role: DeviceRole = 'label_printer';
  supportedOps(): readonly string[] { return ['print_raw', 'print_label']; }

  async handle(cmd: ExecCommand): Promise<ExecResult> {
    if (cmd.op !== 'print_raw' && cmd.op !== 'print_label') {
      return { ok: false, error: `unsupported op '${cmd.op}' on label_printer (epl)` };
    }
    const payload = (cmd.payload ?? {}) as { bytes?: number[] | Uint8Array; epl?: string };
    let bytes: Buffer | null = null;
    if (Array.isArray(payload.bytes) || payload.bytes instanceof Uint8Array) {
      bytes = Buffer.from(payload.bytes as ArrayLike<number>);
    } else if (typeof payload.epl === 'string' && payload.epl.length > 0) {
      bytes = Buffer.from(payload.epl, 'latin1');
    }
    if (!bytes || bytes.length === 0) {
      return {
        ok: false,
        error: `${cmd.op} payload missing bytes/epl — labels must be pre-rendered from label_templates (ADR-0086/D6). Driver does not render from a spec.`,
      };
    }
    return this.send(bytes);
  }
}
