/**
 * Wave 5 — LineMeta → ESC/POS emitter.
 *
 * This is the second consumer of `ReceiptLinesResult` (the first being
 * `renderThermalPdf`). It turns the same padded rows + `LineMeta[]` that
 * the on-screen `MonospacePreview` displays into raw ESC/POS bytes, so
 * that preview / PDF / physical printer all render from a single row
 * producer (`buildReceiptLines`).
 *
 * Scope on this wave:
 *  - Self-contained (no import from `builder.ts`) so introducing it
 *    can't destabilise the current byte-golden builder. A follow-up
 *    swap-out will route `buildDocumentEscPos` through this emitter and
 *    delete the duplicated procedural section emitters in `builder.ts`.
 *  - Same CP858 encoding + ASCII transliteration policy as `builder.ts`
 *    so a byte-parity assertion is meaningful when the swap happens.
 *  - Native QR emission (GS ( k) when caps.qr_native and a `qr:true`
 *    row is present with a `qrPayload`; otherwise the QR row is dropped
 *    silently (the caller can fall back to text QR in the source rows).
 */

import type { ReceiptLinesResult, LineMeta } from "../receipt/lines.ts";

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

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
  FEED: (n: number) => [ESC, 0x64, Math.max(0, Math.min(10, n | 0))],
  PRINT_MODE: (n: number) => [ESC, 0x21, n],
  CODEPAGE_CP858: [ESC, 0x74, 0x13],
};

// Subset — kept in sync with `builder.ts` on purpose. When the two files
// converge, both will import from a shared primitives module.
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
  "…": ".",
  "•": "*",
  "→": "->", "←": "<-", "↔": "<->",
};

function encodeText(s: string, out: number[]): void {
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code <= 0x7f) { out.push(code); continue; }
    const mapped = CP858[ch];
    if (mapped !== undefined) { out.push(mapped); continue; }
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
        if (dc <= 0x7f) { out.push(dc); emitted = true; }
        else if (CP858[d] !== undefined) { out.push(CP858[d]); emitted = true; }
      }
      if (emitted) continue;
    }
    out.push(0x3f); // '?'
  }
}

/** GS ( k — native QR emission sequence (ESC/POS common variant). */
function pushNativeQr(out: number[], payload: string, moduleSize = 6): void {
  // Model 2
  out.push(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00);
  // Module size (1..16). 6 is a good default for 58/80mm rolls.
  const m = Math.max(1, Math.min(16, moduleSize | 0));
  out.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, m);
  // Error correction H (48)
  out.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x30 + 3);
  // Store data
  const data: number[] = [];
  encodeText(payload, data);
  const len = data.length + 3;
  const pL = len & 0xff;
  const pH = (len >> 8) & 0xff;
  out.push(GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30, ...data);
  // Print buffered data
  out.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);
}

export interface RenderLinesEscPosOptions {
  /** Number of LFs after the last row (0..10). Default 4. */
  feedLinesAfter?: number;
  /** Emit a full paper cut at the end. Default true. */
  cut?: boolean;
  /** Printer capability hints. */
  caps?: {
    qr_native?: boolean;
    auto_cut?: boolean;
  };
  /** Native QR module size 1..16. Default 6. */
  qrModuleSize?: number;
}

/**
 * Render an ESC/POS byte stream from a `ReceiptLinesResult`.
 *
 * Guarantees:
 *  - Rows are emitted in order, one LF per row.
 *  - Alignment / bold / large flags come from `meta[i]`. Bold + large are
 *    reset after every row so state doesn't leak between sections.
 *  - `qr:true` rows emit a native QR when `caps.qr_native` is on AND
 *    `qrPayload` is set. Otherwise the row is dropped silently — the
 *    caller decides whether to also emit a textual QR line.
 *  - No CP858 byte ever exceeds `columns` because `buildReceiptLines`
 *    already clamps to profile width (JS string length ≈ CP858 byte
 *    width for the transliteration set above).
 */
export function renderLinesEscPos(
  result: ReceiptLinesResult,
  opts: RenderLinesEscPosOptions = {},
): Uint8Array {
  const out: number[] = [];
  const push = (bytes: number[]) => out.push(...bytes);

  push(CMD.INIT);
  push(CMD.CODEPAGE_CP858);
  // Font A (0x00) / Font B (0x01). Large/bold are per-row via meta.
  push(CMD.PRINT_MODE(result.font === "B" ? 0x01 : 0x00));

  let alignState: "left" | "center" | "right" = "left";
  const setAlign = (a: "left" | "center" | "right") => {
    if (a === alignState) return;
    push(a === "left" ? CMD.ALIGN_LEFT : a === "center" ? CMD.ALIGN_CENTER : CMD.ALIGN_RIGHT);
    alignState = a;
  };

  const qrNative = !!opts.caps?.qr_native;

  for (let i = 0; i < result.lines.length; i++) {
    const m: LineMeta = result.meta[i] ?? { align: "left" };
    const raw = result.lines[i] ?? "";

    if (m.qr) {
      if (qrNative && result.qrPayload) {
        setAlign("center");
        pushNativeQr(out, result.qrPayload, opts.qrModuleSize ?? 6);
        setAlign("left");
      }
      // Non-native: skip the placeholder line; textual fallback is the
      // caller's decision (usually a following center() row with the URL).
      continue;
    }

    setAlign(m.align);
    if (m.bold) push(CMD.BOLD_ON);
    if (m.large) push(CMD.DOUBLE_ON);

    encodeText(raw, out);
    out.push(LF);

    if (m.large) push(CMD.DOUBLE_OFF);
    if (m.bold) push(CMD.BOLD_OFF);
  }

  setAlign("left");
  push(CMD.FEED(opts.feedLinesAfter ?? 4));
  if (opts.cut !== false && opts.caps?.auto_cut !== false) {
    push(CMD.CUT);
  }

  return Uint8Array.from(out);
}