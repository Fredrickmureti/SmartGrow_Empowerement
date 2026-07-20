/**
 * Wave 5 — LineMeta → ESC/POS emitter.
 *
 * This is the second consumer of `ReceiptLinesResult` (the first being
 * `renderThermalPdf`). It turns the same padded rows + `LineMeta[]` that
 * the on-screen `MonospacePreview` displays into raw ESC/POS bytes, so
 * that preview / PDF / physical printer all render from a single row
 * producer (`buildReceiptLines`).
 *
 * Scope:
 *  - Self-contained (no import from the legacy `builder.ts`). Production
 *    receipt callers must use this emitter through `renderDocumentEscPos`.
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

/**
 * ESC/POS Code128 barcode — GS k m n d1..dn (m=73 length-prefixed form).
 * HRI text below, height 80 dots, module width 2 — sensible thermal defaults.
 * Only Code128 subset B is emitted (covers the ASCII payloads Wave 6b
 * produces for document numbers). Non-ASCII bytes fall back to '?'.
 */
function pushCode128(out: number[], data: string): void {
  out.push(GS, 0x48, 0x02);          // HRI position: below
  out.push(GS, 0x68, 0x50);          // Barcode height (dots)
  out.push(GS, 0x77, 0x02);          // Module width
  const payload: number[] = [0x7b, 0x42]; // {B start subset
  for (const ch of data) {
    const c = ch.charCodeAt(0);
    payload.push(c <= 0x7f ? c : 0x3f);
  }
  out.push(GS, 0x6b, 0x49, payload.length, ...payload);
  out.push(LF);
}

export interface RenderLinesEscPosOptions {
  /** Number of LFs after the last row (0..10). Result's `directives.feedLinesAfter` wins if set. */
  feedLinesAfter?: number;
  /** Emit a paper cut at the end. Result's `directives.cutMode` wins if set. */
  cut?: boolean;
  /** Printer capability hints. */
  caps?: {
    qr_native?: boolean;
    auto_cut?: boolean;
    partial_cut?: boolean;
    code128_native?: boolean;
  };
  /** Native QR module size 1..16. Default 6. */
  qrModuleSize?: number;
  /**
   * Wave 6b Phase 3 — honor `result.directives.copies` and repeat the body
   * this many times with optional per-copy labels. Defaults to 1.
   * When false, only a single body is emitted regardless of directives
   * (used by parity tests that want a byte-comparable single-copy stream).
   */
  applyCopies?: boolean;
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
 *  - `barcode` rows emit a native Code128 when `caps.code128_native` is
 *    on (or unset — permissive default). Otherwise the row's text falls
 *    through as a plain textual reference.
 *  - `result.directives` (copies × body, cut policy, trailing feed) are
 *    honored — see `RenderLinesEscPosOptions.applyCopies`.
 *  - No CP858 byte ever exceeds `columns` because `buildReceiptLines`
 *    already clamps to profile width (JS string length ≈ CP858 byte
 *    width for the transliteration set above).
 */
export function renderLinesEscPos(
  result: ReceiptLinesResult,
  opts: RenderLinesEscPosOptions = {},
): Uint8Array {
  const directives = result.directives ?? {};
  const applyCopies = opts.applyCopies !== false;
  const copies = applyCopies
    ? Math.max(1, Math.min(3, directives.copies ?? 1))
    : 1;
  const copyLabels = directives.copyLabels ?? [];

  // Cut policy: directive > opts.cut > default full. Capability downgrades:
  // no auto_cut → "none"; "partial" without partial_cut → "full".
  let cutMode: "full" | "partial" | "none" = directives.cutMode
    ?? (opts.cut === false ? "none" : "full");
  if (opts.caps?.auto_cut === false) cutMode = "none";
  else if (cutMode === "partial" && opts.caps?.partial_cut === false) cutMode = "full";
  const feedLines = directives.feedLinesAfter ?? opts.feedLinesAfter ?? 4;

  const code128Native = opts.caps?.code128_native !== false;
  const qrNative = !!opts.caps?.qr_native;

  const emitBody = (out: number[]) => {
    for (let i = 0; i < result.lines.length; i++) {
      const m: LineMeta = result.meta[i] ?? { align: "left" };
      const raw = result.lines[i] ?? "";

      if (m.qr) {
        if (qrNative && result.qrPayload) {
          setAlign(out, "center");
          pushNativeQr(out, result.qrPayload, opts.qrModuleSize ?? 6);
          setAlign(out, "left");
        }
        continue;
      }

      if (m.barcode) {
        if (code128Native) {
          setAlign(out, "center");
          pushCode128(out, m.barcode.data);
          setAlign(out, "left");
        } else {
          // Textual fallback — printers without Code128 still get the
          // scannable-in-a-pinch text row.
          setAlign(out, m.align);
          encodeText(raw, out);
          out.push(LF);
          setAlign(out, "left");
        }
        continue;
      }

      setAlign(out, m.align);
      if (m.bold) out.push(...CMD.BOLD_ON);
      if (m.large) out.push(...CMD.DOUBLE_ON);

      encodeText(raw, out);
      out.push(LF);

      if (m.large) out.push(...CMD.DOUBLE_OFF);
      if (m.bold) out.push(...CMD.BOLD_OFF);
    }
    setAlign(out, "left");
  };

  const emitFeedCut = (out: number[]) => {
    if (feedLines > 0) out.push(...CMD.FEED(feedLines));
    if (cutMode === "full") out.push(...CMD.CUT);
    else if (cutMode === "partial") out.push(GS, 0x56, 0x01);
  };

  const emitInit = (out: number[]) => {
    out.push(...CMD.INIT);
    out.push(...CMD.CODEPAGE_CP858);
    out.push(...CMD.PRINT_MODE(result.font === "B" ? 0x01 : 0x00));
    alignState.get(out) === "left" || alignState.set(out, "left");
  };

  const out: number[] = [];
  for (let i = 0; i < copies; i++) {
    emitInit(out);
    const label = copyLabels[i]?.trim();
    if (label) {
      setAlign(out, "center");
      out.push(...CMD.BOLD_ON, ...CMD.DOUBLE_ON);
      encodeText(label, out);
      out.push(LF);
      out.push(...CMD.DOUBLE_OFF, ...CMD.BOLD_OFF);
      setAlign(out, "left");
    }
    emitBody(out);
    emitFeedCut(out);
  }

  return Uint8Array.from(out);
}

// Per-buffer alignment cache. Kept out of the emitter closure so we can
// pass raw `number[]` arrays around (fresh state per Uint8Array).
const alignState = new WeakMap<number[], "left" | "center" | "right">();
function setAlign(out: number[], a: "left" | "center" | "right"): void {
  if (alignState.get(out) === a) return;
  out.push(...(a === "left" ? CMD.ALIGN_LEFT : a === "center" ? CMD.ALIGN_CENTER : CMD.ALIGN_RIGHT));
  alignState.set(out, a);
}