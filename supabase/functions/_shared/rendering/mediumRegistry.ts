/**
 * Medium registry (Wave 3, ADR-0084).
 *
 * The single dispatch table that maps a requested `RenderMedium` to a
 * concrete byte producer. New mediums (e.g. `pcl`, `png_preview`) are
 * added HERE — never by branching in an edge function.
 *
 * Renderers return raw bytes plus mime/extension metadata. Persistence
 * (document_artifacts) and transport (email/print/download) are handled
 * one layer up in `engine.ts`.
 */

import type { AstBlock, RenderContext, RenderMedium, ResolvedTemplate } from "./types.ts";
import { renderAstToPdf } from "./renderers/pdf.ts";
import { renderAstToEscPos } from "./renderers/escpos.ts";
import { renderAstToZpl } from "./renderers/zpl.ts";
import { renderAstToHtml } from "./renderers/html.ts";
import { renderAstToCsv } from "./renderers/csv.ts";
import { renderAstToXlsx } from "./renderers/xlsx.ts";

/**
 * A renderer may report what it actually resolved (paper width, column
 * count, font) alongside the bytes. The engine merges this into
 * `RenderResult.metadata` so operator-facing surfaces can show the real
 * server decision instead of re-deriving policy on the client.
 */
export interface RendererOutput {
  bytes: Uint8Array;
  metadata?: Record<string, unknown>;
}

export interface MediumRenderer {
  medium: RenderMedium;
  mime_type: string;
  extension: string;
  render(args: {
    template: ResolvedTemplate;
    context: RenderContext;
    blocks: AstBlock[];
  }): Promise<Uint8Array | RendererOutput> | Uint8Array | RendererOutput;
}

/** Normalise both renderer return shapes into `RendererOutput`. */
export async function runMediumRenderer(
  renderer: MediumRenderer,
  args: { template: ResolvedTemplate; context: RenderContext; blocks: AstBlock[] },
): Promise<RendererOutput> {
  const out = await renderer.render(args);
  return out instanceof Uint8Array ? { bytes: out } : out;
}

const REGISTRY: Record<RenderMedium, MediumRenderer> = {
  pdf: {
    medium: "pdf",
    mime_type: "application/pdf",
    extension: "pdf",
    render: renderAstToPdf,
  },
  escpos: {
    medium: "escpos",
    mime_type: "application/vnd.escpos",
    extension: "bin",
    render: renderAstToEscPos,
  },
  zpl: {
    medium: "zpl",
    mime_type: "application/zpl",
    extension: "zpl",
    render: renderAstToZpl,
  },
  html: {
    medium: "html",
    mime_type: "text/html; charset=utf-8",
    extension: "html",
    render: renderAstToHtml,
  },
  csv: {
    medium: "csv",
    mime_type: "text/csv; charset=utf-8",
    extension: "csv",
    render: renderAstToCsv,
  },
  xlsx: {
    medium: "xlsx",
    mime_type:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
    render: renderAstToXlsx,
  },
};

export function getMediumRenderer(medium: RenderMedium): MediumRenderer {
  const r = REGISTRY[medium];
  if (!r) throw new Error(`unsupported_render_medium:${medium}`);
  return r;
}

/**
 * Flatten header/footer AST fragments around the template body. Kept in
 * the registry so every medium sees the same composed block list.
 */
export function composeBlocks(
  template: ResolvedTemplate,
  context: RenderContext,
): AstBlock[] {
  const head = context.header?.ast ?? [];
  const foot = context.footer?.ast ?? [];
  return [...head, ...template.ast.blocks, ...foot];
}
