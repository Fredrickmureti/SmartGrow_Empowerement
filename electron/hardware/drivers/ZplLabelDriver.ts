/**
 * ZplLabelDriver — Zebra ZPL-II label driver.
 *
 * Audit Wave 9d.8 (P0 #2) + ADR-0086 / D6. Pure transport for pre-rendered
 * ZPL. Callers MUST push bytes/text produced upstream by the canonical
 * label pipeline (`label_templates` → `resolve_label_template` →
 * `renderTemplateBody` in either
 * `supabase/functions/_shared/printing/zpl/builder.ts` server-side or
 * `src/services/printing/labelDispatch.ts` client-side). This driver
 * validates the envelope (`^XA` head, `^XZ` tail), rejects ESC/POS
 * payloads (start with 0x1B 0x40 = ESC @), applies transport-level
 * commands (`^MD`, `^PR`) from the assignment config, then writes to the
 * wire. It does NOT know label layout, does NOT know CODE128 vs QR, and
 * does NOT own a `LabelSpec` — those concerns live in `label_templates`.
 *
 * Two op names are accepted for backwards compatibility; both go through
 * the same passthrough:
 *   - `print_raw`   { bytes | zpl }
 *   - `print_label` { bytes | zpl }
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

interface ZplConfig {
  dpi: 203 | 300;
  widthMm: number;
  heightMm: number;
  encoding: 'latin1' | 'utf8';
  darkness?: number;
  speed?: number;
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
    const payload = (cmd.payload ?? {}) as { bytes?: number[] | Uint8Array; zpl?: string };
    let bytes: Buffer | null = null;
    if (Array.isArray(payload.bytes) || payload.bytes instanceof Uint8Array) {
      bytes = Buffer.from(payload.bytes as ArrayLike<number>);
    } else if (typeof payload.zpl === 'string' && payload.zpl.length > 0) {
      bytes = Buffer.from(this.applyTransportCommands(payload.zpl, cfg), cfg.encoding);
    }
    if (!bytes || bytes.length === 0) {
      return {
        ok: false,
        error: `${cmd.op} payload missing bytes/zpl — labels must be pre-rendered from label_templates (ADR-0086/D6). Driver does not render from a spec.`,
      };
    }
    if (bytes.length >= 2 && bytes[0] === ESC && bytes[1] === AT) {
      return { ok: false, error: 'payload looks like ESC/POS (starts with ESC @). Use receipt_printer role or bind an EscPosLabelDriver.' };
    }
    if (!this.looksLikeZpl(bytes)) {
      return { ok: false, error: 'payload does not look like ZPL — expected ^XA…^XZ envelope.' };
    }
    return this.send(bytes);
  }

  /**
   * Inject transport-only commands (`^MD` darkness, `^PR` speed) right
   * after the `^XA` header. These are NOT layout — they configure the
   * printer itself and must not be encoded into the template body.
   */
  private applyTransportCommands(zpl: string, cfg: ZplConfig): string {
    const parts: string[] = [];
    if (typeof cfg.darkness === 'number') parts.push(`^MD${Math.max(0, Math.min(30, cfg.darkness))}`);
    if (typeof cfg.speed === 'number') parts.push(`^PR${Math.max(1, Math.min(14, cfg.speed))}`);
    if (parts.length === 0) return zpl;
    const head = zpl.indexOf('^XA');
    if (head < 0) return zpl;
    const before = zpl.slice(0, head + 3);
    const after = zpl.slice(head + 3);
    return `${before}\n${parts.join('')}${after.startsWith('\n') ? '' : '\n'}${after}`;
  }

  private looksLikeZpl(buf: Buffer): boolean {
    // Cheap envelope check — first 64 bytes contain ^XA, last 64 contain ^XZ.
    const head = buf.subarray(0, Math.min(64, buf.length)).toString('latin1');
    const tail = buf.subarray(Math.max(0, buf.length - 64)).toString('latin1');
    return head.includes('^XA') && tail.includes('^XZ');
  }
}
