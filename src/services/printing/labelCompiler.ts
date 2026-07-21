/**
 * labelCompiler — ADR-0090 · Visual Label Designer.
 *
 * The visual editor authors labels as a structured document — a list of
 * positioned elements (text, variable, barcode, line, box) in
 * millimeters. At print dispatch time this compiler translates that
 * document into engine-native body bytes (ZPL / EPL / ESC-POS). The
 * dispatcher still owns the paper envelope (`^PW`/`^LL`, `q`/`Q`) — this
 * module only emits CONTENT so ADR-0087 keeps holding.
 *
 * Variable tokens are emitted as `{{token}}` so the existing
 * `renderTemplateBody` mustache pass continues to work — the compiler
 * introduces no new templating language.
 */
import { mmToDots } from "./mediaGeometry";

export type LabelEngine = "zpl" | "epl" | "escpos" | "pdf";

export interface LabelElementBase {
  id: string;
  xMm: number;
  yMm: number;
}

export interface LabelTextElement extends LabelElementBase {
  type: "text";
  text: string;
  fontSize?: number;
  bold?: boolean;
}

export interface LabelVariableElement extends LabelElementBase {
  type: "variable";
  token: string;
  prefix?: string;
  suffix?: string;
  fontSize?: number;
  bold?: boolean;
}

export type BarcodeSymbology = "code128" | "ean13" | "qr";

export interface LabelBarcodeElement extends LabelElementBase {
  type: "barcode";
  token: string;
  symbology: BarcodeSymbology;
  heightMm?: number;
  moduleMm?: number;
  hri?: boolean;
}

export interface LabelLineElement extends LabelElementBase {
  type: "line";
  wMm: number;
  hMm: number;
}

export interface LabelBoxElement extends LabelElementBase {
  type: "box";
  wMm: number;
  hMm: number;
  thicknessMm?: number;
}

export type LabelElement =
  | LabelTextElement
  | LabelVariableElement
  | LabelBarcodeElement
  | LabelLineElement
  | LabelBoxElement;

export interface LabelDoc {
  version: 1;
  elements: LabelElement[];
}

export function isLabelDoc(v: unknown): v is LabelDoc {
  return (
    !!v &&
    typeof v === "object" &&
    (v as LabelDoc).version === 1 &&
    Array.isArray((v as LabelDoc).elements)
  );
}

function tokenSpan(el: LabelVariableElement): string {
  return `${el.prefix ?? ""}{{${el.token}}}${el.suffix ?? ""}`;
}

function zplFont(size = 4, bold = false): string {
  const heights = [14, 18, 22, 28, 34, 42, 52, 64, 80, 100];
  const idx = Math.max(0, Math.min(heights.length - 1, Math.round(size) - 1));
  const h = heights[idx] + (bold ? 4 : 0);
  return `^A0N,${h},${Math.round(h * 0.55)}`;
}

function escapeZplText(s: string): string {
  return s.replace(/\^/g, " ").replace(/~/g, " ");
}

function compileZpl(doc: LabelDoc, dpi: number): string {
  const out: string[] = ["^XA", "^CI28"];
  for (const el of doc.elements) {
    const x = mmToDots(el.xMm, dpi);
    const y = mmToDots(el.yMm, dpi);
    switch (el.type) {
      case "text":
        out.push(`^FO${x},${y}${zplFont(el.fontSize, el.bold)}^FD${escapeZplText(el.text)}^FS`);
        break;
      case "variable":
        out.push(`^FO${x},${y}${zplFont(el.fontSize, el.bold)}^FD${tokenSpan(el)}^FS`);
        break;
      case "barcode": {
        const h = mmToDots(el.heightMm ?? 12, dpi);
        const mw = Math.max(1, Math.round((el.moduleMm ?? 0.33) * (dpi / 25.4)));
        const hri = el.hri ? "Y" : "N";
        const data = el.token.startsWith("=") ? el.token.slice(1) : `{{${el.token}}}`;
        if (el.symbology === "qr") {
          const scale = Math.max(2, Math.min(10, Math.round(el.moduleMm ?? 4)));
          out.push(`^FO${x},${y}^BQN,2,${scale}^FDLA,${data}^FS`);
        } else if (el.symbology === "ean13") {
          out.push(`^FO${x},${y}^BY${mw},2,${h}^BEN,${h},${hri},N^FD${data}^FS`);
        } else {
          out.push(`^FO${x},${y}^BY${mw},2,${h}^BCN,${h},${hri},N,N^FD${data}^FS`);
        }
        break;
      }
      case "line":
      case "box": {
        const w = mmToDots(el.wMm, dpi);
        const h = mmToDots(el.hMm, dpi);
        const t = mmToDots(el.type === "box" ? el.thicknessMm ?? 0.4 : Math.min(el.wMm, el.hMm), dpi);
        out.push(`^FO${x},${y}^GB${w},${h},${t}^FS`);
        break;
      }
    }
  }
  out.push("^XZ");
  return out.join("\n");
}

function eplFont(size = 4): number {
  return Math.max(1, Math.min(5, Math.ceil(size / 2)));
}

function compileEpl(doc: LabelDoc, dpi: number): string {
  const out: string[] = ["N"];
  for (const el of doc.elements) {
    const x = mmToDots(el.xMm, dpi);
    const y = mmToDots(el.yMm, dpi);
    switch (el.type) {
      case "text": {
        const f = eplFont(el.fontSize);
        out.push(`A${x},${y},0,${f},1,1,N,"${el.text.replace(/"/g, "'")}"`);
        break;
      }
      case "variable": {
        const f = eplFont(el.fontSize);
        out.push(`A${x},${y},0,${f},1,1,N,"${tokenSpan(el).replace(/"/g, "'")}"`);
        break;
      }
      case "barcode": {
        const h = mmToDots(el.heightMm ?? 12, dpi);
        const hri = el.hri ? "B" : "N";
        const data = el.token.startsWith("=") ? el.token.slice(1) : `{{${el.token}}}`;
        if (el.symbology === "qr") {
          out.push(`b${x},${y},Q,m2,s${Math.max(3, Math.round(el.moduleMm ?? 4))},"${data}"`);
        } else {
          const sym = el.symbology === "ean13" ? "E30" : "1";
          out.push(`B${x},${y},0,${sym},2,2,${h},${hri},"${data}"`);
        }
        break;
      }
      case "line": {
        const w = mmToDots(el.wMm, dpi);
        const h = mmToDots(el.hMm, dpi);
        out.push(`LO${x},${y},${w},${h}`);
        break;
      }
      case "box": {
        const w = mmToDots(el.wMm, dpi);
        const h = mmToDots(el.hMm, dpi);
        const t = Math.max(1, mmToDots(el.thicknessMm ?? 0.4, dpi));
        out.push(`X${x},${y},${t},${x + w},${y + h}`);
        break;
      }
    }
  }
  out.push("P1");
  return out.join("\n");
}

/**
 * ESC/POS label rendering — Phase B2 (2026-07-21).
 *
 * Prior version concatenated element text with newlines and discarded
 * `xMm`/`yMm`, so any label authored in the visual designer printed as
 * a top-anchored, left-flush block on ESC/POS thermal label printers
 * (common on 80×50 rolls sold as "receipt printers"). This implementation
 * uses positioning primitives so the same `LabelDoc` prints at the correct
 * physical position on ZPL, EPL and ESC/POS hardware.
 *
 * Commands used (all standard ESC/POS, supported by Epson TM-series and
 * every clone printer we ship against):
 *   ESC $ nL nH        — absolute horizontal position (dots)
 *   ESC J n            — feed n dots (advance Y)
 *   GS ! n             — character size (width high nibble, height low nibble)
 *   ESC E n            — bold on/off
 *   GS h n / GS w n    — barcode height / module width
 *   GS H n             — HRI position (0 = none)
 *   GS k m d1..dk NUL  — Code128 barcode data
 *
 * The compiler emits UTF-8 text with inline control codes; the dispatcher
 * still handles the paper envelope (initial `ESC @` reset, final cut) so
 * ADR-0087 (envelope ownership) continues to hold.
 */
function compileEscPos(doc: LabelDoc, dpi: number): string {
  // ESC/POS positions are in dots. Reuse the same mediaGeometry math so a
  // single LabelDoc renders at identical physical size on every engine.
  const sorted = [...doc.elements].sort((a, b) => a.yMm - b.yMm || a.xMm - b.xMm);
  let cursorY = 0; // dots
  const out: string[] = [];
  const ESC = "\x1B";
  const GS = "\x1D";
  const setX = (xDots: number): string => {
    const nL = xDots & 0xff;
    const nH = (xDots >> 8) & 0xff;
    return `${ESC}$${String.fromCharCode(nL)}${String.fromCharCode(nH)}`;
  };
  const feed = (dots: number): string => {
    if (dots <= 0) return "";
    // ESC J n — n is 0..255. Split into multiple commands if needed.
    const chunks: string[] = [];
    let remaining = Math.round(dots);
    while (remaining > 0) {
      const step = Math.min(255, remaining);
      chunks.push(`${ESC}J${String.fromCharCode(step)}`);
      remaining -= step;
    }
    return chunks.join("");
  };
  const setSize = (fontSize = 4, bold = false): string => {
    // Map designer fontSize (1..10) → GS ! width/height (0..7 each nibble).
    const scale = Math.max(0, Math.min(7, Math.round(fontSize / 2) - 1));
    const n = (scale << 4) | scale;
    return `${GS}!${String.fromCharCode(n)}${ESC}E${String.fromCharCode(bold ? 1 : 0)}`;
  };

  for (const el of sorted) {
    const xDots = mmToDots(el.xMm, dpi);
    const yDots = mmToDots(el.yMm, dpi);
    const advance = yDots - cursorY;
    if (advance > 0) {
      out.push(feed(advance));
      cursorY = yDots;
    }
    out.push(setX(xDots));
    switch (el.type) {
      case "text":
        out.push(setSize(el.fontSize, el.bold));
        out.push(el.text);
        out.push("\n");
        cursorY += Math.max(24, mmToDots(3, dpi)); // approximate line height
        break;
      case "variable":
        out.push(setSize(el.fontSize, el.bold));
        out.push(tokenSpan(el));
        out.push("\n");
        cursorY += Math.max(24, mmToDots(3, dpi));
        break;
      case "barcode": {
        const h = mmToDots(el.heightMm ?? 12, dpi);
        const mw = Math.max(2, Math.min(6, Math.round((el.moduleMm ?? 0.33) * (dpi / 25.4))));
        const data = el.token.startsWith("=") ? el.token.slice(1) : `{{${el.token}}}`;
        out.push(`${GS}h${String.fromCharCode(Math.min(255, h))}`);
        out.push(`${GS}w${String.fromCharCode(mw)}`);
        out.push(`${GS}H${String.fromCharCode(el.hri ? 2 : 0)}`);
        // GS k 73 (Code128, format 2 with length prefix)
        const bytes = data.length;
        out.push(`${GS}k\x49${String.fromCharCode(bytes)}${data}`);
        out.push("\n");
        cursorY += h + (el.hri ? mmToDots(3, dpi) : 0);
        break;
      }
      case "line":
      case "box": {
        // ESC/POS has no geometric primitives — draw with hyphens/underscores
        // as a reasonable degradation (documented behaviour on receipt-style
        // label printers). Full raster ownership belongs to a future ZPL/EPL
        // upgrade path.
        const w = mmToDots(el.wMm, dpi);
        const glyphWidth = Math.max(1, Math.round(dpi / 25.4)); // ~1mm per char
        const cols = Math.max(1, Math.round(w / glyphWidth));
        out.push("-".repeat(cols) + "\n");
        cursorY += Math.max(12, mmToDots(1.5, dpi));
        break;
      }
    }
  }
  return out.join("");
}

export function compileLabelDoc(doc: LabelDoc, engine: LabelEngine, dpi: number): string {
  switch (engine) {
    case "zpl":
      return compileZpl(doc, dpi);
    case "epl":
      return compileEpl(doc, dpi);
    case "escpos":
      return compileEscPos(doc);
    case "pdf":
      return "";
  }
}

export const EMPTY_DOC: LabelDoc = { version: 1, elements: [] };
