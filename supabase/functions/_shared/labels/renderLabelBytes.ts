/**
 * Server-side label renderer (Label Operations Engine).
 *
 * The client seam (`src/services/printing/labelDispatch.ts`) renders a
 * label when an operator presses a button. Bulk runs are expanded and
 * dispatched entirely server-side, so the drainer needs the same
 * capability without a browser: resolve the org/branch-scoped template,
 * resolve media geometry, compile `body_json` (visual designer) or use
 * the legacy `body` string, substitute `{{tokens}}`, then emit the
 * complete on-wire byte stream INCLUDING the paper envelope.
 *
 * Envelope note: on the relay path the bytes go straight to the printer
 * (edge_jobs → agent → socket), bypassing the Electron driver that
 * normally injects `^PW`/`^LL` (ZPL) or `q`/`Q` (EPL). This module
 * therefore owns the envelope for server-rendered labels, mirroring
 * `electron/hardware/drivers/ZplLabelDriver.ts` byte-for-byte.
 *
 * Parity guard: src/test/printing/server-label-render-parity.test.ts
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export type LabelEngine = "zpl" | "epl" | "escpos" | "pdf";

export const DEFAULT_LABEL_DPI = 203;

export function dotsPerMm(dpi: number): number {
  if (!Number.isFinite(dpi) || dpi <= 0) return DEFAULT_LABEL_DPI / 25.4;
  return dpi / 25.4;
}

export function mmToDots(mm: number, dpi: number): number {
  if (!Number.isFinite(mm) || mm <= 0) return 1;
  return Math.max(1, Math.round(mm * dotsPerMm(dpi)));
}

/** ASCII-safe substitution value — mirrors `asciiSafeLabelVar`. */
export function asciiSafe(v: unknown, max = 64): string {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .slice(0, max);
}

/** `{{token}}` + mm-geometry substitution — mirrors `renderTemplateBody`. */
export function renderTemplateBody(
  body: string,
  vars: Record<string, unknown>,
  opts: { dpi?: number } = {},
): string {
  const dpi = Number.isFinite(opts.dpi) && (opts.dpi as number) > 0
    ? (opts.dpi as number)
    : DEFAULT_LABEL_DPI;
  const dpmm = dpi / 25.4;
  const toDots = (mm: number) => Math.max(1, Math.round(mm * dpmm));
  const geomResolved = body
    .replace(/\{\{\s*mm\s*:\s*(-?\d+(?:\.\d+)?)\s*\}\}/g, (_m, n) => String(toDots(Number(n))))
    .replace(/\{\{\s*cf\s*:\s*(-?\d+(?:\.\d+)?)\s*mm\s*\}\}/gi, (_m, n) => String(toDots(Number(n))))
    .replace(/\{\{\s*bh\s*:\s*(-?\d+(?:\.\d+)?)\s*mm\s*\}\}/gi, (_m, n) => String(toDots(Number(n))))
    .replace(
      /\{\{\s*by\s*:\s*(-?\d+(?:\.\d+)?)\s*mm\s*\}\}/gi,
      (_m, n) => String(Math.max(1, Math.min(10, Math.round(Number(n) * dpmm)))),
    );
  return geomResolved.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => asciiSafe(vars[key]));
}

// ---------------------------------------------------------------------------
// LabelDoc compilation (port of src/services/printing/labelCompiler.ts)
// ---------------------------------------------------------------------------

interface LabelElement {
  type: "text" | "variable" | "barcode" | "line" | "box";
  xMm: number;
  yMm: number;
  text?: string;
  token?: string;
  prefix?: string;
  suffix?: string;
  fontSize?: number;
  bold?: boolean;
  symbology?: "code128" | "ean13" | "qr";
  heightMm?: number;
  moduleMm?: number;
  hri?: boolean;
  wMm?: number;
  hMm?: number;
  thicknessMm?: number;
}

interface LabelDoc {
  version: 1;
  elements: LabelElement[];
}

export function isLabelDoc(v: unknown): v is LabelDoc {
  return !!v && typeof v === "object" &&
    (v as LabelDoc).version === 1 && Array.isArray((v as LabelDoc).elements);
}

function tokenSpan(el: LabelElement): string {
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
        out.push(`^FO${x},${y}${zplFont(el.fontSize, el.bold)}^FD${escapeZplText(el.text ?? "")}^FS`);
        break;
      case "variable":
        out.push(`^FO${x},${y}${zplFont(el.fontSize, el.bold)}^FD${tokenSpan(el)}^FS`);
        break;
      case "barcode": {
        const h = mmToDots(el.heightMm ?? 12, dpi);
        const mw = Math.max(1, Math.round((el.moduleMm ?? 0.33) * (dpi / 25.4)));
        const hri = el.hri ? "Y" : "N";
        const token = el.token ?? "";
        const data = token.startsWith("=") ? token.slice(1) : `{{${token}}}`;
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
        const w = mmToDots(el.wMm ?? 0, dpi);
        const h = mmToDots(el.hMm ?? 0, dpi);
        const t = mmToDots(
          el.type === "box" ? el.thicknessMm ?? 0.4 : Math.min(el.wMm ?? 0, el.hMm ?? 0),
          dpi,
        );
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
      case "text":
        out.push(`A${x},${y},0,${eplFont(el.fontSize)},1,1,N,"${(el.text ?? "").replace(/"/g, "'")}"`);
        break;
      case "variable":
        out.push(`A${x},${y},0,${eplFont(el.fontSize)},1,1,N,"${tokenSpan(el).replace(/"/g, "'")}"`);
        break;
      case "barcode": {
        const h = mmToDots(el.heightMm ?? 12, dpi);
        const hri = el.hri ? "B" : "N";
        const token = el.token ?? "";
        const data = token.startsWith("=") ? token.slice(1) : `{{${token}}}`;
        if (el.symbology === "qr") {
          out.push(`b${x},${y},Q,m2,s${Math.max(3, Math.round(el.moduleMm ?? 4))},"${data}"`);
        } else {
          const sym = el.symbology === "ean13" ? "E30" : "1";
          out.push(`B${x},${y},0,${sym},2,2,${h},${hri},"${data}"`);
        }
        break;
      }
      case "line": {
        out.push(`LO${x},${y},${mmToDots(el.wMm ?? 0, dpi)},${mmToDots(el.hMm ?? 0, dpi)}`);
        break;
      }
      case "box": {
        const w = mmToDots(el.wMm ?? 0, dpi);
        const h = mmToDots(el.hMm ?? 0, dpi);
        const t = Math.max(1, mmToDots(el.thicknessMm ?? 0.4, dpi));
        out.push(`X${x},${y},${t},${x + w},${y + h}`);
        break;
      }
    }
  }
  out.push("P1");
  return out.join("\n");
}

function compileEscPos(doc: LabelDoc, dpi: number): string {
  const sorted = [...doc.elements].sort((a, b) => a.yMm - b.yMm || a.xMm - b.xMm);
  let cursorY = 0;
  const out: string[] = [];
  const ESC = "\x1B";
  const GS = "\x1D";
  const setX = (xDots: number) =>
    `${ESC}$${String.fromCharCode(xDots & 0xff)}${String.fromCharCode((xDots >> 8) & 0xff)}`;
  const feed = (dots: number): string => {
    if (dots <= 0) return "";
    const chunks: string[] = [];
    let remaining = Math.round(dots);
    while (remaining > 0) {
      const step = Math.min(255, remaining);
      chunks.push(`${ESC}J${String.fromCharCode(step)}`);
      remaining -= step;
    }
    return chunks.join("");
  };
  const setSize = (fontSize = 4, bold = false) => {
    const scale = Math.max(0, Math.min(7, Math.round(fontSize / 2) - 1));
    return `${GS}!${String.fromCharCode((scale << 4) | scale)}${ESC}E${String.fromCharCode(bold ? 1 : 0)}`;
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
        out.push(setSize(el.fontSize, el.bold), el.text ?? "", "\n");
        cursorY += Math.max(24, mmToDots(3, dpi));
        break;
      case "variable":
        out.push(setSize(el.fontSize, el.bold), tokenSpan(el), "\n");
        cursorY += Math.max(24, mmToDots(3, dpi));
        break;
      case "barcode": {
        const h = mmToDots(el.heightMm ?? 12, dpi);
        const mw = Math.max(2, Math.min(6, Math.round((el.moduleMm ?? 0.33) * (dpi / 25.4))));
        const token = el.token ?? "";
        const data = token.startsWith("=") ? token.slice(1) : `{{${token}}}`;
        out.push(`${GS}h${String.fromCharCode(Math.min(255, h))}`);
        out.push(`${GS}w${String.fromCharCode(mw)}`);
        out.push(`${GS}H${String.fromCharCode(el.hri ? 2 : 0)}`);
        out.push(`${GS}k\x49${String.fromCharCode(data.length)}${data}`);
        out.push("\n");
        cursorY += h + (el.hri ? mmToDots(3, dpi) : 0);
        break;
      }
      case "line":
      case "box": {
        const w = mmToDots(el.wMm ?? 0, dpi);
        const glyphWidth = Math.max(1, Math.round(dpi / 25.4));
        out.push("-".repeat(Math.max(1, Math.round(w / glyphWidth))) + "\n");
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
      return compileEscPos(doc, dpi);
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Envelope (mirrors the Electron label drivers — ADR-0087)
// ---------------------------------------------------------------------------

function applyZplEnvelope(zpl: string, widthDots: number, heightDots: number | null): string {
  const stripped = zpl.replace(/\^PW\d+/g, "").replace(/\^LL\d+/g, "");
  const parts = [`^PW${widthDots}`, `^LL${heightDots ?? widthDots}`];
  const head = stripped.indexOf("^XA");
  if (head < 0) return `^XA\n${parts.join("\n")}\n${stripped}\n^XZ`;
  const before = stripped.slice(0, head + 3);
  const after = stripped.slice(head + 3);
  return `${before}\n${parts.join("\n")}${after.startsWith("\n") ? "" : "\n"}${after}`;
}

function applyEplEnvelope(epl: string, widthDots: number, heightDots: number | null): string {
  const body = epl.replace(/^q\d+\n?/gm, "").replace(/^Q\d+,\d+\n?/gm, "");
  const head = [`q${widthDots}`];
  if (heightDots) head.push(`Q${heightDots},24`);
  return `${head.join("\n")}\n${body}`;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface RenderedLabel {
  bytes: Uint8Array;
  engine: LabelEngine;
  mediaProfileId: string | null;
  dpi: number;
}

export type RenderLabelResult =
  | ({ ok: true } & RenderedLabel)
  | { ok: false; error: string };

interface MediaRow {
  id: string;
  widthMm: number;
  heightMm: number | null;
  dpi: number;
}

async function resolveMedia(
  admin: SupabaseClient,
  orgId: string,
  overrideId: string | null,
): Promise<MediaRow | null> {
  const load = async (id: string): Promise<MediaRow | null> => {
    const { data } = await admin
      .from("media_profiles")
      .select("id, width_mm, height_mm")
      .eq("id", id)
      .maybeSingle();
    const m = data as { id?: string; width_mm?: number; height_mm?: number | null } | null;
    if (!m?.id || typeof m.width_mm !== "number") return null;
    return {
      id: m.id,
      widthMm: Number(m.width_mm),
      heightMm: m.height_mm == null ? null : Number(m.height_mm),
      dpi: DEFAULT_LABEL_DPI,
    };
  };

  if (overrideId) {
    const hit = await load(overrideId);
    if (hit) return hit;
  }
  for (const preferDefault of [true, false]) {
    let q = admin
      .from("media_profiles")
      .select("id, width_mm, height_mm")
      .eq("org_id", orgId)
      .eq("active", true)
      .order("created_at", { ascending: true })
      .limit(1);
    if (preferDefault) q = q.eq("is_default", true);
    const { data } = await q.maybeSingle();
    const m = data as { id?: string; width_mm?: number; height_mm?: number | null } | null;
    if (m?.id && typeof m.width_mm === "number") {
      return {
        id: m.id,
        widthMm: Number(m.width_mm),
        heightMm: m.height_mm == null ? null : Number(m.height_mm),
        dpi: DEFAULT_LABEL_DPI,
      };
    }
  }
  return null;
}

export async function renderLabelBytes(
  admin: SupabaseClient,
  input: {
    orgId: string;
    templateKey: string;
    branchId?: string | null;
    mediaProfileId?: string | null;
    dpi?: number | null;
    vars: Record<string, unknown>;
  },
): Promise<RenderLabelResult> {
  const media = await resolveMedia(admin, input.orgId, input.mediaProfileId ?? null);
  const dpi = Number(input.dpi) > 0 ? Number(input.dpi) : (media?.dpi ?? DEFAULT_LABEL_DPI);

  const { data, error } = await admin.rpc("resolve_label_template", {
    p_org_id: input.orgId,
    p_template_key: input.templateKey,
    p_branch_id: input.branchId ?? null,
    p_media_profile_id: media?.id ?? input.mediaProfileId ?? null,
  });
  if (error) return { ok: false, error: `template_resolve_failed:${error.message}` };
  const tpl = (Array.isArray(data) ? data[0] : data) as
    | { engine: LabelEngine; body: string; body_json: unknown }
    | undefined;
  if (!tpl) {
    return {
      ok: false,
      error: `no label template registered for key '${input.templateKey}' in this organization`,
    };
  }

  if ((tpl.engine === "zpl" || tpl.engine === "epl") && !media) {
    return {
      ok: false,
      error:
        `NO_MEDIA_RESOLVED: label template '${input.templateKey}' (engine=${tpl.engine}) requires a media profile. ` +
        `Create one in Platform → Hardware → Media, or mark an existing profile as default.`,
    };
  }

  const mergedVars: Record<string, unknown> = { hri_flag: "N", ...input.vars };
  const source = isLabelDoc(tpl.body_json)
    ? compileLabelDoc(tpl.body_json, tpl.engine, dpi)
    : (tpl.body ?? "");
  let rendered = renderTemplateBody(source, mergedVars, { dpi });

  if (media && tpl.engine === "zpl") {
    rendered = applyZplEnvelope(
      rendered,
      mmToDots(media.widthMm, dpi),
      media.heightMm == null ? null : mmToDots(media.heightMm, dpi),
    );
  } else if (media && tpl.engine === "epl") {
    rendered = applyEplEnvelope(
      rendered,
      mmToDots(media.widthMm, dpi),
      media.heightMm == null ? null : mmToDots(media.heightMm, dpi),
    );
  }

  if (tpl.engine === "pdf") {
    return { ok: false, error: "pdf label engine is not supported on the server run path" };
  }

  return {
    ok: true,
    bytes: new TextEncoder().encode(rendered),
    engine: tpl.engine,
    mediaProfileId: media?.id ?? null,
    dpi,
  };
}
