/**
 * EplLabelDriver — Eltron EPL2 label driver.
 *
 * Audit Wave 9d.8 (P0 #2). Older Zebra/Eltron LP/TLP-class printers
 * speak EPL2 (line-oriented ASCII, no `^XA…^XZ` envelope). Modern Zebra
 * firmware can be set to EPL or ZPL; this driver targets the EPL setting.
 *
 * Ops mirror the ZPL driver:
 *   - `print_raw`   { bytes } — passthrough, light sanity check
 *   - `print_label` { spec  } — render SKU/name/barcode at the configured DPI
 *
 * EPL line set used here:
 *   - N           clear image buffer
 *   - q<width>    set label width in dots
 *   - Q<len>,gap  set label length + gap in dots
 *   - A<x>,<y>,<rot>,<font>,<hmul>,<vmul>,<rev>,"<text>"   text
 *   - B<x>,<y>,<rot>,<bc>,<narrow>,<wide>,<height>,<hrt>,"<data>"  barcode (CODE128 = "1")
 *   - P1          print one copy
 */
import { TransportDriver } from './TransportDriver';
import type { ExecCommand, ExecResult, DeviceRole } from '../types';
import type { LabelSpec } from './ZplLabelDriver';

function mmToDots(mm: number, dpi: number): number {
  return Math.round(mm * (dpi / 25.4));
}
function asciiSafe(s: string | null | undefined, max = 64): string {
  if (!s) return '';
  return s.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/"/g, "'").slice(0, max);
}

export class EplLabelDriver extends TransportDriver {
  readonly role: DeviceRole = 'label_printer';
  supportedOps(): readonly string[] { return ['print_raw', 'print_label']; }

  async handle(cmd: ExecCommand): Promise<ExecResult> {
    if (cmd.op !== 'print_raw' && cmd.op !== 'print_label') {
      return { ok: false, error: `unsupported op '${cmd.op}' on label_printer (epl)` };
    }
    const cfg = this.readConfig();
    const payload = (cmd.payload ?? {}) as { bytes?: number[] | Uint8Array; spec?: LabelSpec; epl?: string };
    let epl: string | null = null;
    let bytes: Buffer | null = null;
    if (cmd.op === 'print_raw') {
      if (Array.isArray(payload.bytes) || payload.bytes instanceof Uint8Array) {
        bytes = Buffer.from(payload.bytes as ArrayLike<number>);
      } else if (typeof payload.epl === 'string' && payload.epl.length > 0) {
        epl = payload.epl;
      }
    } else {
      if (!payload.spec || typeof payload.spec !== 'object') {
        return { ok: false, error: 'print_label payload requires { spec }' };
      }
      epl = this.renderSpec(payload.spec, cfg);
    }
    if (epl) bytes = Buffer.from(epl, 'latin1');
    if (!bytes || bytes.length === 0) {
      return { ok: false, error: `${cmd.op} payload missing bytes/epl/spec` };
    }
    return this.send(bytes);
  }

  private readConfig(): { dpi: number; widthMm: number; heightMm: number; gapMm: number } {
    const c = (this.assignment.config ?? {}) as Record<string, unknown>;
    return {
      dpi: Number(c.dpi) === 300 ? 300 : 203,
      widthMm: Number.isFinite(Number(c.widthMm)) ? Number(c.widthMm) : 80,
      heightMm: Number.isFinite(Number(c.heightMm)) ? Number(c.heightMm) : 50,
      gapMm: Number.isFinite(Number(c.gapMm)) ? Number(c.gapMm) : 3,
    };
  }

  private renderSpec(spec: LabelSpec, cfg: { dpi: number; widthMm: number; heightMm: number; gapMm: number }): string {
    const dots = (mm: number) => mmToDots(mm, cfg.dpi);
    const width = dots(cfg.widthMm);
    const len = dots(cfg.heightMm);
    const gap = dots(cfg.gapMm);
    const lines: string[] = [
      'N',
      `q${width}`,
      `Q${len},${gap}`,
    ];
    let y = 10;
    const name = asciiSafe(spec.name, 36);
    const sku = asciiSafe(spec.sku, 24);
    const price = asciiSafe(spec.price, 14);
    const barcode = asciiSafe(spec.barcode || spec.sku, 24);
    if (name) { lines.push(`A10,${y},0,3,1,1,N,"${name}"`); y += 30; }
    if (sku) { lines.push(`A10,${y},0,2,1,1,N,"SKU: ${sku}"`); y += 25; }
    if (price) { lines.push(`A10,${y},0,4,1,1,N,"${price}"`); y += 45; }
    if (barcode) { lines.push(`B10,${y},0,1,2,2,80,B,"${barcode}"`); y += 110; }
    lines.push('P1');
    return lines.join('\n') + '\n';
  }
}
