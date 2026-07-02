/**
 * Server-side ESC/POS builder — Stage P5 (ADR-0008) + Stage X7
 * (receipt-settings honoring).
 *
 * Consumes:
 *  - `DocumentData` (canonical), so invoices, sales orders, purchase
 *    orders, bills, credit notes, delivery notes, receipts, and
 *    statements all render through the SAME fetchers as the PDF path.
 *  - `BuildOptions.receiptSettings` (Stage X7) — merged
 *    `ExtendedReceiptSettings` for POS receipts. Each section of the
 *    receipt is gated/formatted by these fields so the toggles in
 *    POS Settings → Receipt Settings actually take effect.
 *
 * Output: a `Uint8Array` of raw ESC/POS bytes. Self-contained: no
 * browser-only imports.
 */

import type { DocumentData } from "../templateRenderer.ts";
import { resolveBlockOrder } from "./blocks.ts";
// Receipt overhaul Phase A.2 — engine wired into the items section + uniform
// margin policy. The same primitives drive the in-app monospace preview, so
// what the operator sees in Settings is what the printer emits.
import {
  solveColumns,
  renderRow,
  renderHeader,
} from "../receipt/engine/ColumnLayout.ts";
import {
  resolvePrinterProfile,
  contentWidth,
  type Font as RcptFont,
} from "../receipt/engine/PrinterProfile.ts";
import {
  LAYOUT_REGISTRY,
  resolveLegacyLayout,
  pickFittingLayout,
} from "../receipt/layouts/index.ts";
import { assembleItems } from "../receipt/items.ts";

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;
const NUL = 0x00;

const CMD = {
  INIT: [ESC, 0x40],
  ALIGN_LEFT: [ESC, 0x61, 0x00],
  ALIGN_CENTER: [ESC, 0x61, 0x01],
  ALIGN_RIGHT: [ESC, 0x61, 0x02],
  BOLD_ON: [ESC, 0x45, 0x01],
  BOLD_OFF: [ESC, 0x45, 0x00],
  DOUBLE_ON: [GS, 0x21, 0x11],
  DOUBLE_OFF: [GS, 0x21, 0x00],
  CUT: [GS, 0x56, 0x00],
  FEED: (n: number) => [ESC, 0x64, n],
  // ESC 3 n — set line spacing in dots (default 30). Lower = tighter.
  LINE_SPACING: (n: number) => [ESC, 0x33, n],
  // ESC ! n — print mode (font A/B + width/height bits).
  PRINT_MODE: (n: number) => [ESC, 0x21, n],
  CODEPAGE_CP858: [ESC, 0x74, 0x13],
};

// Unicode → CP858 byte map for characters commonly seen in Latin/European
// business names and currency symbols. Anything not listed falls back to
// an ASCII transliteration (see `transliterate`) and only as a last resort
// to '?'. We never silently drop characters.
const CP858: Record<string, number> = {
  "Ç": 0x80, "ü": 0x81, "é": 0x82, "â": 0x83, "ä": 0x84, "à": 0x85,
  "å": 0x86, "ç": 0x87, "ê": 0x88, "ë": 0x89, "è": 0x8a, "ï": 0x8b,
  "î": 0x8c, "ì": 0x8d, "Ä": 0x8e, "Å": 0x8f, "É": 0x90, "æ": 0x91,
  "Æ": 0x92, "ô": 0x93, "ö": 0x94, "ò": 0x95, "û": 0x96, "ù": 0x97,
  "ÿ": 0x98, "Ö": 0x99, "Ü": 0x9a, "ø": 0x9b, "£": 0x9c, "Ø": 0x9d,
  "×": 0x9e, "ƒ": 0x9f, "á": 0xa0, "í": 0xa1, "ó": 0xa2, "ú": 0xa3,
  "ñ": 0xa4, "Ñ": 0xa5, "ª": 0xa6, "º": 0xa7, "¿": 0xa8, "®": 0xa9,
  "¬": 0xaa, "½": 0xab, "¼": 0xac, "¡": 0xad, "«": 0xae, "»": 0xaf,
  "Á": 0xb5, "Â": 0xb6, "À": 0xb7, "©": 0xb8,
  "¢": 0xbd, "¥": 0xbe,
  "ã": 0xc6, "Ã": 0xc7,
  "¤": 0xcf,
  "ð": 0xd0, "Ð": 0xd1, "Ê": 0xd2, "Ë": 0xd3, "È": 0xd4,
  "€": 0xd5,
  "Í": 0xd6, "Î": 0xd7, "Ï": 0xd8,
  "Ì": 0xde,
  "Ó": 0xe0, "ß": 0xe1, "Ô": 0xe2, "Ò": 0xe3, "õ": 0xe4, "Õ": 0xe5,
  "µ": 0xe6, "þ": 0xe7, "Þ": 0xe8, "Ú": 0xe9, "Û": 0xea, "Ù": 0xeb,
  "ý": 0xec, "Ý": 0xed, "¯": 0xee, "´": 0xef,
  "±": 0xf1, "¾": 0xf3, "¶": 0xf4, "§": 0xf5, "÷": 0xf6, "¸": 0xf7,
  "°": 0xf8, "¨": 0xf9, "·": 0xfa, "¹": 0xfb, "³": 0xfc, "²": 0xfd,
};

const ASCII_TRANSLIT: Record<string, string> = {
  "—": "-", "–": "-", "−": "-",
  "‘": "'", "’": "'", "‚": ",", "‛": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  // Phase A.6 — keep ellipsis as a SINGLE byte so the JS .length used by
  // clampLeft / padLR matches the post-transliteration byte width on the
  // printer. A 3-byte "..." silently widened lines past the column clamp.
  "…": ".",
  "•": "*", "·": ".",
  "→": "->", "←": "<-", "↔": "<->",
};

export type EscPosWidth = "40mm" | "58mm" | "80mm";

// Subset of ExtendedReceiptSettings the builder actually reads. Kept as
// a loose Partial<...> so a stale settings row can't break rendering.
export interface ReceiptSettingsInput {
  // Paper / typography
  paper_size?: "40mm" | "58mm" | "80mm" | "A4" | "A5" | "Letter";
  font_size?: "small" | "medium" | "large";
  line_spacing?: "compact" | "normal" | "relaxed";

  // Header
  receipt_header?: string;
  show_store_name?: boolean;
  show_store_address?: boolean;
  show_store_phone?: boolean;
  show_store_email?: boolean;

  // Meta
  show_receipt_number?: boolean;
  show_date_time?: boolean;
  show_cashier_name?: boolean;
  cashier_label_format?: "cashier" | "served_by";
  show_register_id?: boolean;
  show_customer_name?: boolean;

  // Items
  show_item_sku?: boolean;
  show_item_quantity?: boolean;
  show_unit_price?: boolean;
  show_item_discount?: boolean;
  truncate_long_names?: boolean;
  max_item_name_length?: number;
  item_display_format?: "single-line" | "two-lines" | "tabular";
  /**
   * Multi-unit: print a "(20 ea)" sub-row under any item sold with
   * packaging (e.g. "2 Strip") so the base-unit equivalent is visible.
   * Default ON — mirrors the in-app receipt preview.
   */
  show_base_unit_breakdown?: boolean;

  // Totals
  show_subtotal?: boolean;
  show_discount_total?: boolean;
  show_tax_breakdown?: boolean;
  show_tax_rate?: boolean;
  show_savings?: boolean;

  // Payment
  show_payment_method?: boolean;
  show_amount_tendered?: boolean;
  show_change_due?: boolean;

  // Footer / compliance
  receipt_footer?: string;
  show_return_policy?: boolean;
  return_policy_text?: string;
  show_barcode?: boolean;
  show_qr_code?: boolean;
  show_etims_info?: boolean;
  show_etims_qr?: boolean;

  // ── Stage X8 — configurability extensions (all optional) ──
  header_align?: "left" | "center" | "right";
  meta_align?: "left" | "center" | "right";
  items_header_align?: "left" | "center" | "right";
  totals_align?: "left" | "center" | "right";
  footer_align?: "left" | "center" | "right";

  currency_display?: "symbol" | "code" | "none";
  currency_position?: "before" | "after";
  currency_symbol_override?: string;
  decimal_places?: number;
  thousands_separator?: "," | "." | " " | "";

  date_format?: "iso" | "dmy" | "mdy" | "long";
  time_format?: "12h" | "24h" | "none";

  // ── Stage R2 — line-item enrichment + print behavior (all optional) ──
  show_item_modifiers?: boolean;
  show_refund_banner?: boolean;
  copies?: number;                // 1..3
  copy_labels?: string[];
  cut_mode?: "full" | "partial" | "none";
  feed_lines_after?: number;      // 0..10

  // ── Phase A (receipt overhaul) — margins ──
  /** Left/right margin in character columns. Defaults: 1 on 58mm, 2 on 80mm. */
  margin_cols?: number;

  // ── Phase B — section template + title rules ──
  /**
   * Tenant-defined ordering for non-pinned blocks. Validated by
   * `resolveBlockOrder` (see `blocks.ts`). When undefined, the receipt
   * renders in DEFAULT_BLOCK_ORDER (byte-identical to historical output).
   */
  section_order?: string[];
  /**
   * When true the title resolver suppresses the "TAX INVOICE" promotion
   * for fiscalized cash sales — they print "SALES RECEIPT" instead.
   * On-account sales still title "INVOICE".
   */
  legacy_title_mode?: boolean;
}

interface BuildOptions {
  width?: EscPosWidth;
  /** Override the rendered title (e.g. "TAX INVOICE"). */
  title?: string;
  /** Append after totals (e.g. "Thank you for your business"). */
  footerNote?: string;
  /** Stage X7 — merged ExtendedReceiptSettings for POS receipts. */
  receiptSettings?: ReceiptSettingsInput | null;
  /**
   * Phase D — printer capability profile (per pos_registers row). Builder
   * downgrades unsupported features instead of emitting commands the
   * printer will misinterpret. Missing profile = permissive defaults.
   */
  capabilities?: PrinterCapabilities | null;
  /**
   * Phase A.2 — physical font override from a printer_profiles row.
   * Receipt-settings `font_size` still wins when set explicitly; this is
   * the per-printer baseline (e.g. a 58mm thermal handheld pinned to
   * Font B for narrower glyphs). Values: "A" (default) or "B".
   */
  font?: RcptFont;
}

export interface PrinterCapabilities {
  auto_cut?: boolean;
  partial_cut?: boolean;
  qr_native?: boolean;
  code128_native?: boolean;
  /** Optional override of the column count. */
  columns_override?: number;
}

const DEFAULT_CAPS: Required<Omit<PrinterCapabilities, "columns_override">> = {
  auto_cut: true,
  partial_cut: true,
  qr_native: true,
  code128_native: true,
};

const COLS: Record<EscPosWidth, number> = { "40mm": 24, "58mm": 32, "80mm": 48 };

// Sensible defaults when settings are missing or partial. Mirrors
// DEFAULT_EXTENDED_RECEIPT_SETTINGS in src/lib/receiptConfig.ts (kept
// in sync; duplication is intentional so the edge fn stays self-contained).
const DEFAULT_RS: Required<Omit<ReceiptSettingsInput,
  "paper_size" | "return_policy_text" | "receipt_header" | "receipt_footer" | "section_order" | "legacy_title_mode"
>> & {
  paper_size: NonNullable<ReceiptSettingsInput["paper_size"]>;
  return_policy_text: string;
  receipt_header: string;
  receipt_footer: string;
} = {
  paper_size: "80mm",
  font_size: "medium",
  line_spacing: "normal",

  receipt_header: "",
  show_store_name: true,
  show_store_address: true,
  show_store_phone: true,
  show_store_email: false,

  show_receipt_number: true,
  show_date_time: true,
  show_cashier_name: true,
  cashier_label_format: "cashier",
  show_register_id: false,
  show_customer_name: true,

  show_item_sku: false,
  show_item_quantity: true,
  show_unit_price: true,
  show_item_discount: true,
  truncate_long_names: true,
  max_item_name_length: 28,
  item_display_format: "single-line",
  show_base_unit_breakdown: true,

  show_subtotal: true,
  show_discount_total: true,
  show_tax_breakdown: true,
  show_tax_rate: false,
  show_savings: true,

  show_payment_method: true,
  show_amount_tendered: true,
  show_change_due: true,

  receipt_footer: "",
  show_return_policy: false,
  return_policy_text: "",
  show_barcode: false,
  show_qr_code: false,
  show_etims_info: true,
  show_etims_qr: true,

  // Stage X8 defaults — reproduce previous behaviour exactly.
  header_align: "center",
  meta_align: "center",
  items_header_align: "left",
  totals_align: "left",
  footer_align: "center",

  currency_display: "code",
  currency_position: "before",
  currency_symbol_override: "",
  decimal_places: 2,
  thousands_separator: ",",

  date_format: "iso",
  time_format: "24h",

  // Stage R2 defaults — reproduce previous behaviour exactly.
  show_item_modifiers: true,
  show_refund_banner: true,
  copies: 1,
  copy_labels: [],
  cut_mode: "full",
  feed_lines_after: 4,

  // Intentionally undefined: PrinterProfile picks a paper-aware default
  // (1 col for 58mm, 2 cols for 80mm). Operators can still override per-tenant.
  margin_cols: undefined as unknown as number,
};

function resolveSettings(input?: ReceiptSettingsInput | null) {
  return { ...DEFAULT_RS, ...(input ?? {}) };
}

function paperWidth(rs: ReturnType<typeof resolveSettings>, optsWidth?: EscPosWidth): EscPosWidth {
  // Receipt overhaul Phase 1 — receipt-settings paper_size wins for thermal
  // values. Previously `optsWidth` (from `document_print_policies.paper_format`)
  // unconditionally overrode the editor's intent, so an operator who set
  // 58mm/40mm in the receipt editor still got 80mm bytes when the policy row
  // was the system default. Print policy is a render-mode/transport concern;
  // the actual character grid belongs to the receipt editor / printer profile.
  const fromSettings: EscPosWidth | null =
    rs.paper_size === "40mm" ? "40mm" :
    rs.paper_size === "58mm" ? "58mm" :
    rs.paper_size === "80mm" ? "80mm" : null;
  if (fromSettings) return fromSettings;
  // Audit fix (Phase 1): if receipt settings hold a non-thermal value
  // (A4/A5/Letter) but the print policy resolved a thermal width, prefer the
  // policy. Previously we always fell through to 80mm, which masked
  // misconfigurations as "looks fine on 80mm" while silently dropping the
  // operator's intent to render at 58mm/40mm.
  if (optsWidth === "40mm" || optsWidth === "58mm" || optsWidth === "80mm") {
    return optsWidth;
  }
  if (optsWidth) return optsWidth;
  // A4/A5/Letter on a thermal target → fall back to 80mm so we never crash
  // a printer with bytes it can't display.
  return "80mm";
}

export function buildDocumentEscPos(doc: DocumentData, opts: BuildOptions = {}): Uint8Array {
  const rs = resolveSettings(opts.receiptSettings);
  const caps = { ...DEFAULT_CAPS, ...(opts.capabilities ?? {}) };
  const width = paperWidth(rs, opts.width);

  // Phase A.2 — printer profile is the single source of truth for column
  // count, font metric and margins. Font B (small) yields more columns on
  // the same paper; the engine reflows accordingly instead of under-padding.
  // Precedence for font: receipt_settings.font_size (operator intent) >
  // BuildOptions.font (printer_profiles row baseline) > "A".
  const font: RcptFont =
    rs.font_size === "small" ? "B"
      : rs.font_size === "large" ? "A"
      : (opts.font ?? "A");
  const profile = resolvePrinterProfile({
    paper: width,
    font,
    marginCols: rs.margin_cols,
    columnsOverride: caps.columns_override,
    caps: {
      auto_cut: caps.auto_cut,
      partial_cut: caps.partial_cut,
      qr_native: caps.qr_native,
      code128_native: caps.code128_native,
    },
  });
  const cols = profile.columns;
  const marginCols = profile.marginCols;
  const cw = contentWidth(profile);
  const marginPad = " ".repeat(marginCols);

  const out: number[] = [];

  const push = (bytes: number[]) => out.push(...bytes);
  const text = (s: string) => {
    for (const ch of s) {
      const code = ch.charCodeAt(0);
      if (code <= 0x7f) {
        out.push(code);
        continue;
      }
      const mapped = CP858[ch];
      if (mapped !== undefined) {
        out.push(mapped);
        continue;
      }
      const ascii = ASCII_TRANSLIT[ch];
      if (ascii !== undefined) {
        for (const a of ascii) out.push(a.charCodeAt(0));
        continue;
      }
      const decomposed = ch.normalize("NFD");
      if (decomposed.length > 1) {
        let emitted = false;
        for (const d of decomposed) {
          const dc = d.charCodeAt(0);
          if (dc <= 0x7f) {
            out.push(dc);
            emitted = true;
          } else if (CP858[d] !== undefined) {
            out.push(CP858[d]);
            emitted = true;
          }
        }
        if (emitted) continue;
      }
      out.push(0x3f);
    }
  };

  // Stage X8 — generic per-section align emit. Restores ALIGN_LEFT after.
  const ALIGN_CMD = {
    left: CMD.ALIGN_LEFT,
    center: CMD.ALIGN_CENTER,
    right: CMD.ALIGN_RIGHT,
  } as const;

  // Receipt overhaul — alignment state machine.
  // `line()` adds the left margin only when we're in default LEFT alignment.
  // Centered / right-aligned text emits raw (no margin pad) so the printer's
  // own alignment uses the full physical column width — otherwise centered
  // headers would visibly drift right by `marginCols` characters.
  let alignState: "left" | "center" | "right" = "left";
  const setAlign = (a: "left" | "center" | "right") => {
    if (a === alignState) return;
    push(ALIGN_CMD[a]);
    alignState = a;
  };
  // Phase A.3 — hard line-width clamp. Even if a future block forgets to
  // wrap a long token, we MUST never emit a printable line longer than the
  // physical column count of the resolved profile, or the printer wraps
  // mid-character and the receipt visibly overflows. The clamp is a
  // last-resort ellipsis on the *content* portion (margins are added back
  // after clamping) so well-behaved blocks pay zero cost.
  const clampLeft = (s: string, max: number): string => {
    if (s.length <= max) return s;
    if (max <= 1) return s.slice(0, max);
    return s.slice(0, max - 1) + "\u2026"; // "…"
  };
  const rawLine = (s = "") => {
    text(clampLeft(s, cols));
    out.push(LF);
  };
  const line = (s = "") => {
    if (alignState === "left" && marginCols > 0) {
      // Phase A.6 — clamp the CONTENT to content-width first, THEN prepend
      // the left margin. This guarantees `marginPad + content` can never
      // exceed `cols` regardless of what upstream produced (item rows from
      // assembleItems, modifier wraps, padLR rows, etc.).
      const content = s.length > cw ? clampLeft(s, cw) : s;
      text(marginPad + content);
    } else {
      text(clampLeft(s, cols));
    }
    out.push(LF);
  };
  // Rule fills the *content* width so the right margin is naturally clear.
  const rule = (ch = "-") => line(ch.repeat(cw));
  const center = (s: string) => {
    setAlign("center");
    rawLine(s);
    setAlign("left");
  };
  const aligned = (s: string, align: "left" | "center" | "right") => {
    if (align === "left") {
      line(s);
      return;
    }
    setAlign(align);
    rawLine(s);
    setAlign("left");
  };
  const alignedLines = (lines: string[], align: "left" | "center" | "right") => {
    if (!lines.length) return;
    if (align === "left") {
      for (const l of lines) line(l);
      return;
    }
    setAlign(align);
    for (const l of lines) rawLine(l);
    setAlign("left");
  };
  // Receipt overhaul Phase 1 — overflow-safe wrap. Hard-splits long
  // single tokens (URLs, IDs, signatures, big SKUs) so a stray reference
  // can never push a line past the printable column count.
  const wrap = (s: string, width = cw): string[] => {
    const w = Math.max(1, width | 0);
    const words = String(s ?? "").split(/\s+/).filter(Boolean);
    if (!words.length) return [""];
    const lines: string[] = [];
    let cur = "";
    const pushCur = () => { if (cur) { lines.push(cur); cur = ""; } };
    for (const word of words) {
      let token = word;
      while (token.length > w) {
        pushCur();
        lines.push(token.slice(0, w));
        token = token.slice(w);
      }
      if (!cur) { cur = token; continue; }
      if ((cur + " " + token).length <= w) cur += " " + token;
      else { pushCur(); cur = token; }
    }
    pushCur();
    return lines.length ? lines : [""];
  };
  // Receipt overhaul Phase 1 — overflow-safe padLR. When the right-hand
  // value (money / change / reference) plus a single space would push past
  // the row width, the LEFT label is truncated with an ellipsis instead of
  // letting the row overflow the printable area. The right-hand value is
  // never cut — it carries the canonical figure.
  const padLR = (left: string, right: string, width = cw): string => {
    const w = Math.max(1, width | 0);
    const r = String(right ?? "");
    const l = String(left ?? "");
    if (r.length >= w) return r.slice(0, w);
    const room = w - r.length - 1;
    if (l.length <= room) {
      return l + " ".repeat(w - l.length - r.length) + r;
    }
    if (room <= 1) return l.slice(0, room) + " " + r;
    return l.slice(0, room - 1) + "…" + " " + r;
  };
  const truncate = (s: string, max: number) =>
    s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";

  // ── Stage X8 — currency formatter ────────────────────────────────────────
  const CURRENCY_SYMBOLS: Record<string, string> = {
    USD: "$", EUR: "€", GBP: "£", JPY: "¥", KES: "KSh", UGX: "USh",
    TZS: "TSh", RWF: "RF", NGN: "₦", ZAR: "R", INR: "₹", CNY: "¥",
    AED: "AED", SAR: "SAR", AUD: "A$", CAD: "C$",
  };
  const docCurrency = (doc.currency ?? "").trim();
  const fmtNumber = (n: number): string => {
    const dp = Math.max(0, Math.min(4, rs.decimal_places ?? 2));
    const fixed = Number(n ?? 0).toFixed(dp);
    const sep = rs.thousands_separator ?? ",";
    if (!sep) return fixed;
    const [intPart, decPart] = fixed.split(".");
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
    return decPart != null ? `${grouped}.${decPart}` : grouped;
  };
  const currencyToken = (): string => {
    if (rs.currency_display === "none") return "";
    if (rs.currency_symbol_override && rs.currency_symbol_override.trim()) {
      return rs.currency_symbol_override.trim();
    }
    if (rs.currency_display === "symbol") {
      return CURRENCY_SYMBOLS[docCurrency.toUpperCase()] ?? docCurrency;
    }
    return docCurrency;
  };
  const fmtCur = (n: number): string => {
    const tok = currencyToken();
    const num = fmtNumber(Number(n ?? 0));
    if (!tok) return num;
    return rs.currency_position === "after" ? `${num} ${tok}` : `${tok} ${num}`;
  };

  // ── Stage X8 / R1 — date / time formatter (timezone-aware) ──────────────
  // Honours organization IANA timezone (e.g. "Africa/Nairobi"). When the
  // timezone is missing we fall back to UTC — identical to pre-R1 output.
  const tz = (doc.organization as { timezone?: string | null } | null | undefined)?.timezone || "UTC";
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const pad2 = (n: number) => String(n).padStart(2, "0");
  // Resolve a Date in the target tz to its YYYY-MM-DD-HH-mm parts. We use
  // Intl.DateTimeFormat parts because Deno's Date methods are UTC/local only.
  const tzParts = (d: Date) => {
    try {
      const fmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      });
      const parts: Record<string, string> = {};
      for (const p of fmt.formatToParts(d)) {
        if (p.type !== "literal") parts[p.type] = p.value;
      }
      return {
        y: Number(parts.year),
        mo: Number(parts.month),
        da: Number(parts.day),
        h: Number(parts.hour === "24" ? "00" : parts.hour),
        mi: Number(parts.minute),
      };
    } catch {
      // Invalid IANA name → fall back to UTC.
      return {
        y: d.getUTCFullYear(),
        mo: d.getUTCMonth() + 1,
        da: d.getUTCDate(),
        h: d.getUTCHours(),
        mi: d.getUTCMinutes(),
      };
    }
  };
  const fmtDateTime = (input: string | null | undefined): string => {
    if (!input) return "";
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) return String(input);
    const { y, mo, da, h: h24, mi } = tzParts(d);
    let datePart = "";
    switch (rs.date_format) {
      case "dmy": datePart = `${pad2(da)}/${pad2(mo)}/${y}`; break;
      case "mdy": datePart = `${pad2(mo)}/${pad2(da)}/${y}`; break;
      case "long": datePart = `${da} ${MONTHS[mo - 1]} ${y}`; break;
      default: datePart = `${y}-${pad2(mo)}-${pad2(da)}`;
    }
    if (rs.time_format === "none") return datePart;
    if (rs.time_format === "12h") {
      const am = h24 < 12;
      const h12 = ((h24 + 11) % 12) + 1;
      return `${datePart} ${pad2(h12)}:${pad2(mi)} ${am ? "AM" : "PM"}`;
    }
    return `${datePart} ${pad2(h24)}:${pad2(mi)}`;
  };

  push(CMD.INIT);
  push(CMD.CODEPAGE_CP858);
  setAlign("left");

  // Typography — line spacing.
  const lineSpacingDots: Record<string, number> = { compact: 24, normal: 32, relaxed: 44 };
  push(CMD.LINE_SPACING(lineSpacingDots[rs.line_spacing] ?? 32));

  // Typography — base font. ESC ! n bits: 0x10 = double height, 0x20 = double width.
  // small => Font B (bit 0x01), medium => Font A (0x00), large => Font A.
  // We honour "large" only on opt-in sections (org name, title, TOTAL row)
  // via per-emit DOUBLE_ON, never globally — that would balloon the receipt.
  const printModes: Record<string, number> = { small: 0x01, medium: 0x00, large: 0x00 };
  push(CMD.PRINT_MODE(printModes[rs.font_size] ?? 0x00));
  const wantsLargeAccent = rs.font_size === "large";

  // Resolve per-section alignments (Stage X8).
  const headerAlign = rs.header_align ?? "center";
  const metaAlign = rs.meta_align ?? "center";
  const footerAlign = rs.footer_align ?? "center";

  // ── Phase B: block-dispatch refactor ─────────────────────────────────────
  // Each section is a closure keyed by BlockType. We then iterate
  // `resolveBlockOrder(rs)` (which honors `rs.section_order` while pinning
  // compliance-critical blocks). Default order produces byte-identical
  // output to the previous procedural emit (locked by builder_test.ts /
  // blocks_test.ts).

  const items = doc.items ?? [];
  const fmtMoney = (n: number) => fmtNumber(Number(n ?? 0));
  const fmtQty = (n: number) => {
    const v = Number(n ?? 0);
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  };
  const itemsAlign = rs.items_header_align ?? "left";
  const totalsAlign = rs.totals_align ?? "left";
  const totalsLine = (left: string, right: string) => {
    if (totalsAlign !== "left") setAlign(totalsAlign);
    line(padLR(left, right));
    if (totalsAlign !== "left") setAlign("left");
  };
  const renderItemExtras = (it: any) => {
    if (!rs.show_item_modifiers) return;
    const mods = it?.modifiers;
    if (Array.isArray(mods)) {
      for (const m of mods) {
        if (!m) continue;
        if (typeof m === "string") {
          wrap(`+ ${m}`, cols - 2).forEach((l) => line("  " + l));
        } else if (typeof m === "object") {
          const nm = String(m.name ?? m.label ?? "").trim();
          if (!nm) continue;
          const price = Number(m.price ?? 0);
          if (price > 0) {
            line(padLR(`  + ${truncate(nm, cols - 4 - fmtNumber(price).length - 1)}`, fmtNumber(price)));
          } else {
            wrap(`+ ${nm}`, cols - 2).forEach((l) => line("  " + l));
          }
        }
      }
    }
    const notes = it?.notes;
    if (notes && typeof notes === "string" && notes.trim()) {
      wrap(`Note: ${notes.trim()}`, cols - 2).forEach((l) => line("  " + l));
    }
  };
  const payments = (doc as any).pos_payments as Array<{ payment_method: string; amount: number; reference?: string | null }> | undefined;
  const etimsCu = (doc as any).etims_cu_number as string | null | undefined;
  const etimsQr = (doc as any).etims_qr_data as string | null | undefined;
  const fiscalBlock = (doc as any).fiscal_block as
    | { provider: string; heading?: string; fields?: Array<{ label: string; value: string }>; qr?: string | null; signature?: string | null }
    | null
    | undefined;

  type BlockEmitter = () => void;
  const EMITTERS: Record<string, BlockEmitter> = {
    custom_header: () => {
      if (rs.receipt_header && rs.receipt_header.trim()) {
        alignedLines(wrap(rs.receipt_header, cols), headerAlign);
      }
    },

    org_header: () => {
      const org = doc.organization;
      if (org) {
        if (rs.show_store_name && org.name) {
          if (headerAlign !== "left") setAlign(headerAlign);
          push(CMD.DOUBLE_ON);
          if (wantsLargeAccent) push(CMD.PRINT_MODE(0x30));
          line(org.name.slice(0, Math.floor(cols / 2)));
          if (wantsLargeAccent) push(CMD.PRINT_MODE(printModes[rs.font_size] ?? 0x00));
          push(CMD.DOUBLE_OFF);
          if (headerAlign !== "left") setAlign("left");
        }
        if (rs.show_store_address) {
          const addrLines: string[] = [];
          if (org.address) addrLines.push(...wrap(org.address));
          const cityLine = [org.city, org.state, org.postal_code].filter(Boolean).join(" ");
          if (cityLine) addrLines.push(cityLine);
          alignedLines(addrLines, headerAlign);
        }
        if (rs.show_store_phone && org.phone) aligned(org.phone, headerAlign);
        if (rs.show_store_email && org.email) aligned(org.email, headerAlign);
        if (org.tax_id) aligned(`Tax ID: ${org.tax_id}`, headerAlign);
      }
      rule();
    },

    title_meta: () => {
      const title = opts.title ?? doc.document_type_label ?? doc.document_type.toUpperCase().replace(/_/g, " ");
      if (wantsLargeAccent) {
        if (metaAlign !== "left") setAlign(metaAlign);
        push(CMD.DOUBLE_ON);
        line(title);
        push(CMD.DOUBLE_OFF);
        if (metaAlign !== "left") setAlign("left");
      } else {
        aligned(title, metaAlign);
      }
      if (rs.show_receipt_number && doc.document_number) {
        // Number prints centered/aligned under the title with a `#` prefix —
        // dropping the redundant "No:" label that real-world POS receipts
        // never use. Keeps the meta block tight and professional.
        aligned(`#${doc.document_number}`, metaAlign);
      }
      if (rs.show_date_time && doc.issue_date) line(padLR("Date:", fmtDateTime(doc.issue_date)));
      if (doc.due_date) line(padLR("Due:", fmtDateTime(doc.due_date)));
      if (doc.status) line(padLR("Status:", doc.status));
    },

    cashier_register: () => {
      const cashierLabel = rs.cashier_label_format === "served_by" ? "Served by:" : "Cashier:";
      if (rs.show_cashier_name && (doc as any).cashier_name) {
        line(padLR(cashierLabel, String((doc as any).cashier_name)));
      }
      if (rs.show_register_id) {
        const reg = (doc as any).register_name || (doc as any).register_id;
        if (reg) line(padLR("Register:", String(reg)));
      }
      rule();
    },

    recipient: () => {
      if (rs.show_customer_name && doc.contact && doc.contact.name) {
        push(CMD.BOLD_ON);
        // Customer-payment receipts: the contact is the PAYER, not a billing
        // target. Use accountant-correct phrasing.
        line(doc.document_type === "receipt" ? "Received From:" : "Bill To:");
        push(CMD.BOLD_OFF);
        line(doc.contact.name);
        if (doc.contact.company) line(doc.contact.company);
        if (doc.contact.address_line1) wrap(doc.contact.address_line1).forEach((l) => line(l));
        const ctyLine = [doc.contact.city, doc.contact.state, doc.contact.postal_code].filter(Boolean).join(" ");
        if (ctyLine) line(ctyLine);
        if (doc.contact.phone) line(doc.contact.phone);
        if (doc.contact.email) line(doc.contact.email);
        rule();
      }
    },

    items: () => {
      // Customer-payment receipts: replace product-grid rendering with a
      // dedicated allocation table so the receipt explains which invoices
      // the payment settled (and any remaining balance per invoice).
      const allocs = (doc as any).payment_allocations as Array<any> | undefined;
      if (doc.document_type === "receipt" && Array.isArray(allocs) && allocs.length > 0) {
        push(CMD.BOLD_ON);
        line("Applied To Invoices");
        push(CMD.BOLD_OFF);
        rule();
        let totalApplied = 0;
        for (const a of allocs) {
          const num = String(a.invoice_number || "");
          const applied = Number(a.amount_applied) || 0;
          const balance = Number(a.balance_after) || 0;
          totalApplied += applied;
          line(padLR(num, fmtCur(applied)));
          if (a.invoice_date) line(`  date: ${a.invoice_date}`);
          line(padLR("  bal:", fmtCur(balance)));
        }
        rule();
        push(CMD.BOLD_ON);
        line(padLR("Total Applied", fmtCur(totalApplied)));
        push(CMD.BOLD_OFF);
        const unapplied = Number((doc as any).unapplied_amount || 0);
        if (unapplied > 0) {
          line(padLR("Unapplied advance", fmtCur(unapplied)));
        }
        rule();
        return;
      }
      if (items.length === 0) return;

      // Phase B.0 — items section is now produced by the SHARED `assembleItems`
      // helper (used by both the ESC/POS path and the in-app monospace
      // preview), so column math, item shape, and sub-row formatting cannot
      // diverge.
      const preferredLayoutId = resolveLegacyLayout(rs.item_display_format, !!rs.show_item_sku);
      const ctx = {
        showSku: !!rs.show_item_sku,
        showQty: !!rs.show_item_quantity,
        showUnitPrice: !!rs.show_unit_price,
        showDiscount: !!rs.show_item_discount,
        showTaxBreakdown: !!rs.show_tax_breakdown,
        showTaxRate: !!rs.show_tax_rate,
        showModifiers: !!rs.show_item_modifiers,
        truncateLongNames: !!rs.truncate_long_names,
        maxNameLen: rs.max_item_name_length ?? 28,
        showBaseUnitBreakdown: rs.show_base_unit_breakdown !== false,
      };
      // Phase 2 — auto-downgrade tabular_sku → tabular → compact → detailed
      // when content width can't physically host the preferred grid.
      const { layoutId } = pickFittingLayout(preferredLayoutId, ctx, cw);

      const rawItems = items.map((it) => {
        const itAny = it as unknown as Record<string, unknown>;
        const dqRaw = itAny.display_quantity;
        const dq = dqRaw == null ? null : Number(dqRaw);
        return {
          product_name: String(it.description ?? "Item"),
          sku: itAny.sku as string | null | undefined,
          quantity: Number(it.quantity ?? 0),
          unit_price: Number(it.unit_price ?? 0),
          line_total: Number(it.line_total ?? Number(it.quantity ?? 0) * Number(it.unit_price ?? 0)),
          discount_amount: Number(itAny.discount_amount ?? 0),
          tax_amount: Number(it.tax_amount ?? 0),
          tax_rate: it.tax_rate ?? undefined,
          tax_rate_name: itAny.tax_rate_name as string | undefined,
          // Multi-unit pack provenance — forwarded to assembleItems so the
          // qty cell renders the transaction unit ("2 Strip") instead of
          // collapsing to base units ("20").
          display_quantity: Number.isFinite(dq as number) ? (dq as number) : null,
          packaging_label: (itAny.packaging_label as string | null | undefined) ?? null,
          base_uom_label: (itAny.base_uom_label as string | null | undefined) ?? null,
        };
      });

      const assembled = assembleItems({
        items: rawItems,
        layoutId,
        ctx,
        contentWidth: cw,
        fmt: {
          fmtMoney: (n: number) => fmtMoney(n),
          fmtQty: (n: number) => fmtQty(n),
          truncate: (s: string, max: number) => truncate(s, max),
        },
      });

      // Emit each abstract row, applying ESC/POS bold + items alignment for
      // heading / header rows. Per-item modifier / notes extras (engine-
      // specific text wrapping) are flushed right after the LAST row of each
      // source item, preserving the byte order of the previous inline path.
      for (let i = 0; i < assembled.rows.length; i++) {
        const row = assembled.rows[i];
        const isBold = !!row.bold;
        const needsAlign = row.kind === "heading" || row.kind === "header";
        if (needsAlign && itemsAlign !== "left") setAlign(itemsAlign);
        if (isBold) push(CMD.BOLD_ON);
        line(row.text);
        if (isBold) push(CMD.BOLD_OFF);
        if (needsAlign && itemsAlign !== "left") setAlign("left");

        const next = assembled.rows[i + 1];
        const isLastRowOfItem =
          row.itemIndex !== null &&
          (!next || next.itemIndex !== row.itemIndex);
        if (isLastRowOfItem && row.itemIndex !== null) {
          renderItemExtras(items[row.itemIndex]);
        }
      }

      rule();
    },

    totals: () => {
      if (rs.show_subtotal && doc.subtotal != null) {
        totalsLine("Subtotal", fmtCur(doc.subtotal));
      }
      if (rs.show_discount_total && Number(doc.discount_amount ?? 0) > 0) {
        totalsLine("Discount", `-${fmtCur(doc.discount_amount)}`);
      }
      if (Number(doc.tax_amount ?? 0) > 0) {
        if (rs.show_tax_breakdown) {
          const buckets = new Map<string, { name: string; rate: number | null; amount: number }>();
          let bucketed = 0;
          for (const it of (doc.items ?? [])) {
            const amt = Number(it.tax_amount ?? 0);
            if (amt <= 0) continue;
            const name = (it as any).tax_rate_name || "Tax";
            const key = `${name}|${it.tax_rate ?? ""}`;
            const bucket = buckets.get(key);
            if (bucket) bucket.amount += amt;
            else buckets.set(key, { name, rate: it.tax_rate ?? null, amount: amt });
            bucketed += amt;
          }
          if (buckets.size > 0 && Math.abs(bucketed - Number(doc.tax_amount)) < 0.05) {
            for (const b of buckets.values()) {
              const rateLabel = rs.show_tax_rate && b.rate != null ? ` ${Number(b.rate).toFixed(0)}%` : "";
              totalsLine(`${b.name}${rateLabel}`, fmtCur(b.amount));
            }
          } else {
            totalsLine("Tax", fmtCur(doc.tax_amount));
          }
        } else {
          totalsLine("Tax", fmtCur(doc.tax_amount));
        }
      }
    },

    refund_banner: () => {
      if (rs.show_refund_banner && Number(doc.total ?? 0) < 0) {
        setAlign("center");
        push(CMD.BOLD_ON);
        push(CMD.DOUBLE_ON);
        line("REFUND");
        push(CMD.DOUBLE_OFF);
        push(CMD.BOLD_OFF);
        setAlign("left");
      }
    },

    grand_total: () => {
      if (totalsAlign !== "left") setAlign(totalsAlign);
      push(CMD.BOLD_ON);
      if (wantsLargeAccent) push(CMD.PRINT_MODE(0x10));
      line(padLR("TOTAL", fmtCur(doc.total)));
      if (wantsLargeAccent) push(CMD.PRINT_MODE(printModes[rs.font_size] ?? 0x00));
      push(CMD.BOLD_OFF);
      if (totalsAlign !== "left") setAlign("left");
    },

    savings: () => {
      if (rs.show_savings && Number(doc.discount_amount ?? 0) > 0) {
        totalsLine("You saved", fmtCur(doc.discount_amount));
      }
    },

    payments: () => {
      if (rs.show_payment_method && payments && payments.length > 0) {
        const methodLabels: Record<string, string> = {
          cash: "Cash", credit_card: "Credit Card", debit_card: "Debit Card",
          mobile_money: "Mobile Money", mpesa: "M-Pesa", credit: "Credit (A/R)",
          bank_transfer: "Bank Transfer", gift_card: "Gift Card", other: "Other",
        };
        rule();
        for (const p of payments) {
          const label = methodLabels[p.payment_method] ?? p.payment_method;
          totalsLine(label, fmtCur(Number(p.amount ?? 0)));
          if (p.reference) line(`  Ref: ${p.reference}`);
        }
      }
    },

    tendered_change: () => {
      if (rs.show_amount_tendered && payments) {
        const cashTendered = payments
          .filter((p) => p.payment_method === "cash")
          .reduce((s, p) => s + Number(p.amount ?? 0), 0);
        if (cashTendered > 0) {
          totalsLine("Tendered", fmtCur(cashTendered));
          if (rs.show_change_due) {
            const totalNum = Number(doc.total ?? 0);
            const nonCashPaid = payments
              .filter((p) => p.payment_method !== "cash")
              .reduce((s, p) => s + Number(p.amount ?? 0), 0);
            const cashDueFromCustomer = Math.max(0, totalNum - nonCashPaid);
            const change = cashTendered - cashDueFromCustomer;
            if (change > 0) totalsLine("Change", fmtCur(change));
          }
        }
      }
      rule();
    },

    notes: () => {
      if (doc.notes) {
        push(CMD.BOLD_ON);
        line("Notes:");
        push(CMD.BOLD_OFF);
        wrap(doc.notes).forEach((l) => line(l));
        line();
      }
    },

    terms: () => {
      if (doc.terms) {
        push(CMD.BOLD_ON);
        line("Terms:");
        push(CMD.BOLD_OFF);
        wrap(doc.terms).forEach((l) => line(l));
        line();
      }
    },

    footer_text: () => {
      if (rs.receipt_footer && rs.receipt_footer.trim()) {
        alignedLines(wrap(rs.receipt_footer, cols), footerAlign);
      } else if (opts.footerNote) {
        aligned(opts.footerNote, footerAlign);
      }
    },

    return_policy: () => {
      if (rs.show_return_policy && rs.return_policy_text && rs.return_policy_text.trim()) {
        line();
        push(CMD.BOLD_ON);
        line("Return Policy:");
        push(CMD.BOLD_OFF);
        wrap(rs.return_policy_text, cols).forEach((l) => line(l));
      }
    },

    fiscal_etims_ke: () => {
      // Phase B — provider-agnostic. When `doc.fiscal_block` is set the
      // builder renders that generic shape (heading + label/value rows + QR
      // + optional signature). Otherwise it falls back to the legacy
      // eTIMS-only path (etims_cu_number / etims_qr_data) so existing
      // snapshots keep rendering byte-identical to before this refactor.
      if (fiscalBlock && Array.isArray(fiscalBlock.fields)) {
        const heading = (fiscalBlock.heading ?? fiscalBlock.provider).toString().trim() || "FISCAL";
        if (rs.show_etims_info && fiscalBlock.fields.length > 0) {
          line();
          push(CMD.BOLD_ON);
          center(heading);
          push(CMD.BOLD_OFF);
          for (const f of fiscalBlock.fields) {
            if (!f) continue;
            const label = String(f.label ?? "").trim();
            const value = String(f.value ?? "").trim();
            if (!label && !value) continue;
            line(padLR(label ? `${label}:` : "", value));
          }
          if (fiscalBlock.signature && String(fiscalBlock.signature).trim()) {
            line(padLR("Sig:", String(fiscalBlock.signature).trim()));
          }
        }
        if (rs.show_etims_qr && fiscalBlock.qr) {
          if (caps.qr_native) {
            setAlign("center");
            pushQrCode(out, String(fiscalBlock.qr));
            setAlign("left");
          } else {
            aligned(`QR: ${fiscalBlock.qr}`, "center");
          }
        }
        return;
      }
      // Legacy eTIMS path (byte-identical to pre-Phase-B).
      if (rs.show_etims_info && etimsCu) {
        line();
        push(CMD.BOLD_ON);
        center("eTIMS");
        push(CMD.BOLD_OFF);
        line(padLR("CU No:", etimsCu));
      }
      if (rs.show_etims_qr && etimsQr) {
        if (caps.qr_native) {
          setAlign("center");
          pushQrCode(out, etimsQr);
          setAlign("left");
        } else {
          aligned(`QR: ${etimsQr}`, "center");
        }
      }
    },

    barcode: () => {
      if (rs.show_barcode && doc.document_number) {
        if (caps.code128_native) {
          line();
          setAlign("center");
          pushCode128(out, doc.document_number);
          setAlign("left");
        }
      }
    },

    qr_code: () => {
      const fbQr = fiscalBlock?.qr;
      const hasFiscalQr = !!(etimsQr || fbQr);
      if (rs.show_qr_code && !hasFiscalQr && doc.document_number) {
        if (caps.qr_native) {
          setAlign("center");
          pushQrCode(out, doc.document_number);
          setAlign("left");
        } else {
          aligned(`Ref: ${doc.document_number}`, "center");
        }
      }
    },
  };

  const order = resolveBlockOrder(rs);
  for (const t of order) {
    const emit = EMITTERS[t];
    if (emit) emit();
  }


  // ── Stage R2 — copies + cut policy ──
  // Capture body bytes once, then re-emit per copy with optional banner +
  // configurable feed/cut. Copy 1 keeps prior byte-stable behaviour when
  // copies=1, cut_mode='full', feed_lines_after=4 (the defaults).
  const numCopies = Math.max(1, Math.min(3, Math.floor(rs.copies ?? 1)));
  const feedN = Math.max(0, Math.min(10, Math.floor(rs.feed_lines_after ?? 4)));
  // Phase D — coerce cut mode by capability. A printer without an auto-cutter
  // gets only the configured feed lines (so paper still advances for a clean
  // hand-tear). Partial-cut downgrades to full-cut when the printer reports
  // partial=false but auto_cut=true.
  let cutMode = rs.cut_mode ?? "full";
  if (!caps.auto_cut) cutMode = "none";
  else if (cutMode === "partial" && !caps.partial_cut) cutMode = "full";
  const labels = Array.isArray(rs.copy_labels) ? rs.copy_labels : [];
  const emitFeedCut = () => {
    if (feedN > 0) push(CMD.FEED(feedN));
    if (cutMode === "full") push(CMD.CUT);
    else if (cutMode === "partial") out.push(GS, 0x56, 0x01);
    // 'none' → no cut command
  };

  if (numCopies <= 1) {
    emitFeedCut();
  } else {
    // Snapshot the single-copy body, then rebuild with banners + repeats.
    const oneCopy = Uint8Array.from(out);
    out.length = 0;
    for (let i = 0; i < numCopies; i++) {
      const label = labels[i];
      if (label && String(label).trim()) {
        push(CMD.INIT);
        push(CMD.CODEPAGE_CP858);
        setAlign("center");
        push(CMD.BOLD_ON);
        push(CMD.DOUBLE_ON);
        line(String(label).trim());
        push(CMD.DOUBLE_OFF);
        push(CMD.BOLD_OFF);
        setAlign("left");
      }
      for (let b = 0; b < oneCopy.length; b++) out.push(oneCopy[b]);
      emitFeedCut();
    }
  }

  return new Uint8Array(out);
}

// ── ESC/POS QR (GS ( k, model 2) ────────────────────────────────────────────
function pushQrCode(out: number[], data: string, size = 6) {
  const bytes: number[] = [];
  for (const ch of data) {
    const code = ch.charCodeAt(0);
    if (code <= 0xff) bytes.push(code);
    else bytes.push(0x3f);
  }
  // Model: GS ( k 04 00 31 41 32 00
  out.push(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00);
  // Size: GS ( k 03 00 31 43 n  (n=1..16)
  out.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.max(1, Math.min(16, size)));
  // Error correction: M (49)
  out.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31);
  // Store data: GS ( k pL pH 31 50 30 <data>
  const len = bytes.length + 3;
  const pL = len & 0xff;
  const pH = (len >> 8) & 0xff;
  out.push(GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30, ...bytes);
  // Print: GS ( k 03 00 31 51 30
  out.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);
  out.push(LF);
}

// ── ESC/POS CODE128 barcode ────────────────────────────────────────────────
function pushCode128(out: number[], data: string) {
  // Set HRI position above (0=none, 1=above, 2=below, 3=both)
  out.push(GS, 0x48, 0x02);
  // Set barcode height in dots
  out.push(GS, 0x68, 0x50);
  // Set module width
  out.push(GS, 0x77, 0x02);
  // GS k m n d1...dn  (m=73 = CODE128, length-prefixed form)
  const payload: number[] = [0x7b, 0x42]; // {B selector
  for (const ch of data) {
    const c = ch.charCodeAt(0);
    payload.push(c <= 0x7f ? c : 0x3f);
  }
  out.push(GS, 0x6b, 0x49, payload.length, ...payload);
  out.push(LF);
  void NUL; // keep import-style constant referenced
}
