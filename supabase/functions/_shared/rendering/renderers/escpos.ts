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
  const width = (opts["width"] as ThermalWidth | undefined) ?? "80mm";
  const capabilities =
    (opts["capabilities"] as RenderDocumentEscPosOptions["capabilities"]) ?? null;
  const receiptSettings = (opts["receiptSettings"] as Record<string, unknown> | undefined) ?? null;
  const font = (opts["font"] as "A" | "B" | undefined) ?? "A";

  const snap = args.context.document.snapshot as Record<string, unknown>;
  const doc = {
    organization: args.context.business,
    document: { ...snap, id: args.context.document.id },
    items: (snap["items"] as unknown[]) ?? [],
    contact: snap["contact"] ?? null,
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
