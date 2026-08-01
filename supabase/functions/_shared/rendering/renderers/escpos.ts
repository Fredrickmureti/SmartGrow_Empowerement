/**
 * AST → ESC/POS adapter (Wave 3).
 *
 * Delegates to the canonical `renderDocumentEscPosWithResult`, which is
 * itself fed by the shared receipt-lines engine (ADR-0008). The AST
 * blocks act as feature toggles — presence of a `totals` block enables
 * the totals section, a `fiscal` block enables the ETIMS/CRA fiscal
 * footer, etc. Geometry (column width, cut, drawer kick) stays in the
 * ESC/POS builder.
 */

import type { AstBlock, RenderContext, ResolvedTemplate } from "../types.ts";
import { renderDocumentEscPosWithResult, type ThermalWidth } from "../../escpos/renderDocumentEscPos.ts";

import type { RenderDocumentEscPosOptions } from "../../escpos/renderDocumentEscPos.ts";

export function renderAstToEscPos(args: {
  template: ResolvedTemplate;
  context: RenderContext;
  blocks: AstBlock[];
}): { bytes: Uint8Array; metadata: Record<string, unknown> } {
  const opts = args.context.options as Record<string, unknown>;
  const capabilities =
    (opts["capabilities"] as RenderDocumentEscPosOptions["capabilities"]) ?? null;
  const font = (opts["font"] as "A" | "B" | undefined) ?? "A";

  // The receipt/ESC-POS renderer consumes the same flat `DocumentData`
  // snapshot shape as the PDF renderer. Wrapping the snapshot under a
  // `document` key leaves `document_type` undefined and crashes the row
  // builder at `doc.document_type.toUpperCase()`.
  const snap = args.context.document.snapshot as Record<string, unknown>;
  const doc = {
    ...snap,
    id: args.context.document.id,
    organization:
      (snap["organization"] as unknown) ??
      (args.context.business as unknown) ??
      null,
  } as unknown as Parameters<typeof renderDocumentEscPosWithResult>[0];

  // Presentation profile: the snapshot carries the resolved
  // `pos_receipt_settings` (company ← register merge, frozen at issue
  // time). Render options may only *layer on top* of it. Previously this
  // adapter read `options.receiptSettings` alone — always absent on the
  // snapshot path — so every printed receipt silently ignored the saved
  // layout while the on-screen preview honoured it.
  const snapRs = (snap["pos_receipt_settings"] as Record<string, unknown> | undefined) ?? null;
  const optRs = (opts["receiptSettings"] as Record<string, unknown> | undefined) ?? null;
  const receiptSettings: Record<string, unknown> | null =
    snapRs || optRs ? { ...(snapRs ?? {}), ...(optRs ?? {}) } : null;

  const width =
    thermalWidthFromOptions(opts)
    ?? thermalWidth(receiptSettings?.["paper_size"])
    ?? "80mm";

  const { bytes, rows } = renderDocumentEscPosWithResult(doc, {
    width,
    title: (opts["title"] as string | undefined) ?? undefined,
    receiptSettings,
    capabilities,
    font,
  });

  return {
    bytes,
    // What the builder actually resolved — surfaced to the operator as the
    // "resolved by server" diagnostics on the receipt test print.
    metadata: {
      resolved_paper: rows.paper,
      resolved_columns: rows.columns,
      resolved_font: rows.font,
      resolved_margin_columns: rows.marginCols,
      // Preview authority: these are the exact canonical rows that were
      // encoded into `bytes` above. Browser receipt previews consume this
      // server result instead of rebuilding rows from live POS state.
      preview_lines: rows.lines,
      preview_line_meta: rows.meta,
      preview_directives: rows.directives ?? {},
    },
  };
}

function thermalWidth(value: unknown): ThermalWidth | null {
  return value === "40mm" || value === "58mm" || value === "80mm" ? value : null;
}

function thermalWidthFromOptions(opts: Record<string, unknown>): ThermalWidth | null {
  return thermalWidth(opts["width"] ?? opts["paper_format"] ?? opts["paperFormat"]);
}

