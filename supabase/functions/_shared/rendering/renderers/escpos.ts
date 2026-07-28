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
}): Uint8Array {
  const opts = args.context.options as Record<string, unknown>;
  const width = thermalWidthFromOptions(opts) ?? "80mm";
  const capabilities =
    (opts["capabilities"] as RenderDocumentEscPosOptions["capabilities"]) ?? null;
  const receiptSettings = (opts["receiptSettings"] as Record<string, unknown> | undefined) ?? null;
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

  const { bytes } = renderDocumentEscPosWithResult(doc, {
    width,
    title: (opts["title"] as string | undefined) ?? undefined,
    receiptSettings,
    capabilities,
    font,
  });
  return bytes;
}

function thermalWidthFromOptions(opts: Record<string, unknown>): ThermalWidth | null {
  const width = opts["width"] ?? opts["paper_format"] ?? opts["paperFormat"];
  return width === "40mm" || width === "58mm" || width === "80mm"
    ? width
    : null;
}
