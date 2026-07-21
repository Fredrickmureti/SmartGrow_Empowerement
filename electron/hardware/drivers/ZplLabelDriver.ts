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
 * Configuration (payload takes precedence over `assignment.config`, so the
 * canonical `media_profiles` + `printer_profiles` pipeline wins over any
 * per-device leftover):
 *   - dpi:        152 | 203 | 300 | 600     (default 203)
 *   - widthMm:    number                    (default 80)
 *   - heightMm:   number                    (default 50)
 *   - encoding:   'latin1' | 'utf8'         (default 'latin1' — ZPL bytes)
 *   - darkness:   0..30                     (optional ^MD command)
 *   - speed:      1..14                     (optional ^PR command)
 *
 * Envelope emission (ADR-0087): the driver strips any `^PW`/`^LL` present
 * in the incoming body and re-emits them from the resolved media so the
 * same template body renders correctly on 50×30, 80×50 or 102×152 mm at
 * 203 or 300 dpi. Template bodies MUST NOT own paper geometry.
 *
 * Why a separate driver: ESC/POS receipt printers DO NOT speak ZPL and
 * vice versa. A "label printer" that's actually a 80mm thermal receipt
 * with a label roll uses `EscPosLabelDriver`; a Zebra GK420/ZD420 uses
 * this driver. Selection happens in `electron/hardware/drivers/index.ts`
 * `buildDriver()` by `assignment.driver` (`zpl_label`).
 */
import { TransportDriver } from './TransportDriver';
import type { ExecCommand, ExecResult, DeviceRole } from '../types';
import { mediaDots } from '../../../src/services/printing/mediaGeometry';

const ESC = 0x1B;
const AT = 0x40;

interface ZplConfig {
  dpi: 152 | 203 | 300 | 600;
  widthMm: number;
  heightMm: number;
  encoding: 'latin1' | 'utf8';
  darkness?: number;
  speed?: number;
}

export class ZplLabelDriver extends TransportDriver {
  readonly role: DeviceRole = 'label_printer';

  supportedOps(): readonly string[] { return ['print_raw', 'print_label']; }

  private normDpi(n: unknown): 152 | 203 | 300 | 600 {
    const v = Number(n);
    if (v === 600) return 600;
    if (v === 300) return 300;
    if (v === 152) return 152;
    return 203;
  }

  private readConfig(payload?: { mediaWidthMm?: number; mediaHeightMm?: number; dpi?: number; darkness?: number; speed?: number }): ZplConfig {
    const c = (this.assignment.config ?? {}) as Record<string, unknown>;
    // Payload > assignment.config. Payload originates from printer_profiles
    // + media_profiles (canonical). Config is legacy per-device override.
    const dpi = this.normDpi(payload?.dpi ?? c.dpi);
    const widthMm = Number.isFinite(Number(payload?.mediaWidthMm)) ? Number(payload?.mediaWidthMm)
                  : Number.isFinite(Number(c.widthMm)) ? Number(c.widthMm) : 80;
    const heightMm = Number.isFinite(Number(payload?.mediaHeightMm)) ? Number(payload?.mediaHeightMm)
                   : Number.isFinite(Number(c.heightMm)) ? Number(c.heightMm) : 50;
    const encoding = c.encoding === 'utf8' ? 'utf8' : 'latin1';
    const darkness = Number.isFinite(Number(payload?.darkness)) ? Number(payload?.darkness)
                   : Number.isFinite(Number(c.darkness)) ? Number(c.darkness) : undefined;
    const speed = Number.isFinite(Number(payload?.speed)) ? Number(payload?.speed)
                : Number.isFinite(Number(c.speed)) ? Number(c.speed) : undefined;
    return { dpi, widthMm, heightMm, encoding, darkness, speed };
  }

  async handle(cmd: ExecCommand): Promise<ExecResult> {
    if (cmd.op !== 'print_raw' && cmd.op !== 'print_label') {
      return { ok: false, error: `unsupported op '${cmd.op}' on label_printer (zpl)` };
    }
    const payloadObj = (cmd.payload ?? {}) as {
      bytes?: number[] | Uint8Array;
      zpl?: string;
      mediaWidthMm?: number;
      mediaHeightMm?: number;
      dpi?: number;
      darkness?: number;
      speed?: number;
    };
    const cfg = this.readConfig(payloadObj);
    let bytes: Buffer | null = null;
    if (Array.isArray(payloadObj.bytes) || payloadObj.bytes instanceof Uint8Array) {
      // Pre-rendered opaque bytes — trust the caller entirely.
      bytes = Buffer.from(payloadObj.bytes as ArrayLike<number>);
    } else if (typeof payloadObj.zpl === 'string' && payloadObj.zpl.length > 0) {
      const stripped = this.stripEnvelope(payloadObj.zpl);
      bytes = Buffer.from(this.applyEnvelopeAndTransport(stripped, cfg), cfg.encoding);
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
   * Strip any paper-envelope commands (`^PW`, `^LL`) already present in
   * the incoming body. Envelope is a driver responsibility now (ADR-0087);
   * legacy templates that still embed them must not override the resolved
   * media geometry.
   */
  private stripEnvelope(zpl: string): string {
    return zpl.replace(/\^PW\d+/g, '').replace(/\^LL\d+/g, '');
  }

  /**
   * Inject paper envelope (`^PW`, `^LL`) and transport commands (`^MD`,
   * `^PR`) right after the `^XA` header. Dot conversion is delegated to
   * `mediaGeometry.mediaDots` (Phase 14) so all four transports —
   * ZPL, EPL, browser adapter, and preview canvas — share one owner.
   */
  private applyEnvelopeAndTransport(zpl: string, cfg: ZplConfig): string {
    const { widthDots, heightDots } = mediaDots({ widthMm: cfg.widthMm, heightMm: cfg.heightMm, dpi: cfg.dpi });
    const parts: string[] = [`^PW${widthDots}`, `^LL${heightDots ?? widthDots}`];
    if (typeof cfg.darkness === 'number') parts.push(`^MD${Math.max(0, Math.min(30, cfg.darkness))}`);
    if (typeof cfg.speed === 'number') parts.push(`^PR${Math.max(1, Math.min(14, cfg.speed))}`);
    const head = zpl.indexOf('^XA');
    if (head < 0) return `^XA\n${parts.join('\n')}\n${zpl}\n^XZ`;
    const before = zpl.slice(0, head + 3);
    const after = zpl.slice(head + 3);
    return `${before}\n${parts.join('\n')}${after.startsWith('\n') ? '' : '\n'}${after}`;
  }

  private looksLikeZpl(buf: Buffer): boolean {
    // Cheap envelope check — first 64 bytes contain ^XA, last 64 contain ^XZ.
    const head = buf.subarray(0, Math.min(64, buf.length)).toString('latin1');
    const tail = buf.subarray(Math.max(0, buf.length - 64)).toString('latin1');
    return head.includes('^XA') && tail.includes('^XZ');
  }
}
