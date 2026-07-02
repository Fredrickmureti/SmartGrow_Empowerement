/**
 * ZplLabelDriver — Zebra ZPL-II label driver.
 *
 * Audit Wave 9d.8 (P0 #2). Real ZPL driver: callers pass pre-rendered
 * ZPL bytes (produced by `supabase/functions/_shared/printing/zpl/builder.ts`
 * server-side) or a structured `LabelSpec` and we assemble a valid
 * `^XA … ^XZ` envelope on the wire.
 *
 * Two op shapes are supported:
 *   - `print_raw`   { bytes: number[] | Uint8Array }
 *                   Bytes pass through verbatim. The driver validates the
 *                   envelope (`^XA` head, `^XZ` tail) and rejects payloads
 *                   that look like ESC/POS (start with 0x1B 0x40 = ESC @).
 *   - `print_label` { spec: LabelSpec }
 *                   Structured rendering for callers that don't want to
 *                   know ZPL — header fields (SKU, name, price) + CODE128
 *                   barcode, at the configured DPI and dimensions.
 *
 * Configuration on `assignment.config`:
 *   - dpi:        203 | 300                 (default 203)
 *   - widthMm:    number                    (default 80)
 *   - heightMm:   number                    (default 50)
 *   - encoding:   'latin1' | 'utf8'         (default 'latin1' — ZPL bytes)
 *   - darkness:   0..30                     (optional ^MD command)
 *   - speed:      1..14                     (optional ^PR command)
 *
 * Why a separate driver: ESC/POS receipt printers DO NOT speak ZPL and
 * vice versa. A "label printer" that's actually a 80mm thermal receipt
 * with a label roll uses `EscPosLabelDriver`; a Zebra GK420/ZD420 uses
 * this driver. Selection happens in `electron/hardware/drivers/index.ts`
 * `buildDriver()` by `assignment.driver` (`zpl_label`).
 */
import { TransportDriver } from './TransportDriver';
import type { ExecCommand, ExecResult, DeviceRole } from '../types';

const ESC = 0x1B;
const AT = 0x40;

export interface LabelSpec {
  sku?: string;
  name?: string;
  price?: string;
  barcode?: string;          // CODE128
  qrcode?: string;           // square QR (model 2)
  secondary?: string;        // e.g. lot / expiry
}

interface ZplConfig {
  dpi: 203 | 300;
  widthMm: number;
  heightMm: number;
  encoding: 'latin1' | 'utf8';
  darkness?: number;
  speed?: number;
}

function mmToDots(mm: number, dpi: number): number {
  return Math.round(mm * (dpi / 25.4));
}

function asciiSafe(s: string | null | undefined, max = 64): string {
  if (!s) return '';
  return s.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').slice(0, max);
}

export class ZplLabelDriver extends TransportDriver {
  readonly role: DeviceRole = 'label_printer';

  supportedOps(): readonly string[] { return ['print_raw', 'print_label']; }

  private readConfig(): ZplConfig {
    const c = (this.assignment.config ?? {}) as Record<string, unknown>;
    const dpiRaw = Number(c.dpi);
    const dpi: 203 | 300 = dpiRaw === 300 ? 300 : 203;
    const widthMm = Number.isFinite(Number(c.widthMm)) ? Number(c.widthMm) : 80;
    const heightMm = Number.isFinite(Number(c.heightMm)) ? Number(c.heightMm) : 50;
    const encoding = c.encoding === 'utf8' ? 'utf8' : 'latin1';
    const darkness = Number.isFinite(Number(c.darkness)) ? Number(c.darkness) : undefined;
    const speed = Number.isFinite(Number(c.speed)) ? Number(c.speed) : undefined;
    return { dpi, widthMm, heightMm, encoding, darkness, speed };
  }

  async handle(cmd: ExecCommand): Promise<ExecResult> {
    if (cmd.op !== 'print_raw' && cmd.op !== 'print_label') {
      return { ok: false, error: `unsupported op '${cmd.op}' on label_printer (zpl)` };
    }
    const cfg = this.readConfig();
    const payload = (cmd.payload ?? {}) as { bytes?: number[] | Uint8Array; spec?: LabelSpec; zpl?: string };
    let zpl: string | null = null;
    let bytes: Buffer | null = null;

    if (cmd.op === 'print_raw') {
      if (Array.isArray(payload.bytes) || payload.bytes instanceof Uint8Array) {
        bytes = Buffer.from(payload.bytes as ArrayLike<number>);
      } else if (typeof payload.zpl === 'string' && payload.zpl.length > 0) {
        zpl = payload.zpl;
      }
      if (bytes && bytes.length >= 2 && bytes[0] === ESC && bytes[1] === AT) {
        return { ok: false, error: 'payload looks like ESC/POS (starts with ESC @). Use receipt_printer role or bind an EscPosLabelDriver.' };
      }
      if (bytes && !this.looksLikeZpl(bytes)) {
        return { ok: false, error: 'payload does not look like ZPL — expected ^XA…^XZ envelope.' };
      }
    } else {
      // print_label — render from spec
      if (!payload.spec || typeof payload.spec !== 'object') {
        return { ok: false, error: 'print_label payload requires { spec }' };
      }
      zpl = this.renderSpec(payload.spec, cfg);
    }

    if (zpl) {
      bytes = Buffer.from(zpl, cfg.encoding);
    }
    if (!bytes || bytes.length === 0) {
      return { ok: false, error: `${cmd.op} payload missing bytes/zpl/spec` };
    }
    return this.send(bytes);
  }

  private looksLikeZpl(buf: Buffer): boolean {
    // Cheap envelope check — first 64 bytes contain ^XA, last 64 contain ^XZ.
    const head = buf.subarray(0, Math.min(64, buf.length)).toString('latin1');
    const tail = buf.subarray(Math.max(0, buf.length - 64)).toString('latin1');
    return head.includes('^XA') && tail.includes('^XZ');
  }

  private renderSpec(spec: LabelSpec, cfg: ZplConfig): string {
    const dots = (mm: number) => mmToDots(mm, cfg.dpi);
    const pw = dots(cfg.widthMm);
    const ll = dots(cfg.heightMm);
    const lines: string[] = ['^XA'];
    if (typeof cfg.darkness === 'number') lines.push(`^MD${Math.max(0, Math.min(30, cfg.darkness))}`);
    if (typeof cfg.speed === 'number') lines.push(`^PR${Math.max(1, Math.min(14, cfg.speed))}`);
    lines.push(`^PW${pw}`);
    lines.push(`^LL${ll}`);
    lines.push('^LH0,0');
    lines.push('^CF0,30');

    const name = asciiSafe(spec.name, 36);
    const sku = asciiSafe(spec.sku, 24);
    const sec = asciiSafe(spec.secondary, 32);
    const price = asciiSafe(spec.price, 14);
    const barcode = asciiSafe(spec.barcode || spec.sku, 24);
    const qr = asciiSafe(spec.qrcode, 256);

    let y = 20;
    if (name) { lines.push(`^FO20,${y}^FD${name}^FS`); y += 40; }
    if (sku) { lines.push(`^CF0,24^FO20,${y}^FDSKU: ${sku}^FS`); y += 30; }
    if (sec) { lines.push(`^FO20,${y}^FD${sec}^FS`); y += 30; }
    if (price) { lines.push(`^CF0,40^FO20,${y}^FD${price}^FS`); y += 50; }
    if (barcode) {
      lines.push('^BY2,2,80');
      lines.push(`^FO20,${y}^BCN,80,Y,N,N^FD${barcode}^FS`);
      y += 110;
    }
    if (qr) {
      // QR placed top-right when there's room
      lines.push(`^FO${Math.max(0, pw - 160)},20^BQN,2,6^FDLA,${qr}^FS`);
    }
    lines.push('^XZ');
    return lines.join('\n');
  }
}
