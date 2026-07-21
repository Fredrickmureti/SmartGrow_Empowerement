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
 * `{ bytes | epl }` payload.
 *
 * Envelope (ADR-0087): EPL bodies MUST NOT own `q<dots>` / `Q<dots>`
 * paper commands. When the incoming payload has `mediaWidthMm`,
 * `mediaHeightMm`, and `dpi`, the driver strips any embedded `q/Q` and
 * re-emits them from the resolved media profile so a single template body
 * renders on any label size.
 */
import { TransportDriver } from './TransportDriver';
import type { ExecCommand, ExecResult, DeviceRole } from '../types';
import { mediaDots } from '../../../src/services/printing/mediaGeometry';



export class EplLabelDriver extends TransportDriver {
  readonly role: DeviceRole = 'label_printer';
  supportedOps(): readonly string[] { return ['print_raw', 'print_label']; }

  async handle(cmd: ExecCommand): Promise<ExecResult> {
    if (cmd.op !== 'print_raw' && cmd.op !== 'print_label') {
      return { ok: false, error: `unsupported op '${cmd.op}' on label_printer (epl)` };
    }
    const payload = (cmd.payload ?? {}) as {
      bytes?: number[] | Uint8Array;
      epl?: string;
      mediaWidthMm?: number;
      mediaHeightMm?: number;
      dpi?: number;
    };
    let bytes: Buffer | null = null;
    if (Array.isArray(payload.bytes) || payload.bytes instanceof Uint8Array) {
      bytes = Buffer.from(payload.bytes as ArrayLike<number>);
    } else if (typeof payload.epl === 'string' && payload.epl.length > 0) {
      const enveloped = this.applyEnvelope(payload.epl, payload);
      bytes = Buffer.from(enveloped, 'latin1');
    }
    if (!bytes || bytes.length === 0) {
      return {
        ok: false,
        error: `${cmd.op} payload missing bytes/epl — labels must be pre-rendered from label_templates (ADR-0086/D6). Driver does not render from a spec.`,
      };
    }
    return this.send(bytes);
  }

  /** Strip embedded paper envelope (`q<dots>`, `Q<dots>,<gap>`) and
   *  prepend a fresh envelope derived from the resolved media profile.
   *  When no media hints are provided in the payload, the body is left
   *  untouched (backwards-compatible passthrough). */
  private applyEnvelope(epl: string, p: { mediaWidthMm?: number; mediaHeightMm?: number; dpi?: number }): string {
    if (!Number.isFinite(Number(p.mediaWidthMm)) || !Number.isFinite(Number(p.mediaHeightMm))) {
      return epl;
    }
    const { widthDots, heightDots } = mediaDots({
      widthMm: Number(p.mediaWidthMm),
      heightMm: Number(p.mediaHeightMm),
      dpi: Number(p.dpi) || 203,
    });
    const stripped = epl
      .replace(/^\s*q\d+\s*\r?\n/gm, '')
      .replace(/^\s*Q\d+,\d+(?:\+\d+)?\s*\r?\n/gm, '');
    return `q${widthDots}\r\nQ${heightDots ?? widthDots},24\r\n${stripped}`;
  }
}
