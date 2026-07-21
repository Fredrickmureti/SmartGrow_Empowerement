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

function compileEscPos(doc: LabelDoc): string {
  const parts: string[] = [];
  for (const el of doc.elements) {
    if (el.type === "text") parts.push(el.text);
    else if (el.type === "variable") parts.push(tokenSpan(el));
    else if (el.type === "barcode") {
      const data = el.token.startsWith("=") ? el.token.slice(1) : `{{${el.token}}}`;
      parts.push(data);
    }
  }
  return parts.join("\n") + "\n";
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
