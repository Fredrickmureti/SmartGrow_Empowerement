/**
 * renderDocumentEscPos — canonical DocumentData → ESC/POS bytes.
 *
 * This is the ESC/POS wire path counterpart to `renderThermalPdf`. Both
 * consume the SAME `ReceiptLinesResult` produced by `buildReceiptLines`,
 * so the on-screen `MonospacePreview`, the thermal PDF, and the raw
 * bytes sent to a physical printer (or the Espresso emulator) all
 * render from a single row producer.
 *
 * See ADR-0008 and Wave 6b parity gate (`parity_gate_test.ts`) — the
 * shared engine was already the PDF's row producer; this helper is the
 * final swap-out that eliminates the "PDF looks right, raw ESC/POS looks
 * wrong" discrepancy by routing both through one code path.
 *
 * Callers in `generate-document/index.ts` use this instead of the legacy
 * procedural builder, which is retained only for historical byte fixtures.
 */

import type { DocumentData } from "../templateRenderer.ts";
import type { ReceiptLinesResult } from "../receipt/lines.ts";
import { documentToReceiptLines } from "../receipt/documentToLines.ts";
import { renderLinesEscPos } from "./renderLinesEscPos.ts";

export type ThermalWidth = "40mm" | "58mm" | "80mm";

export interface RenderDocumentEscPosOptions {
  /** Physical paper width. Defaults to receipt-settings, then 80mm. */
  width?: ThermalWidth;
  /** Override the resolved title (e.g. "TAX INVOICE"). */
  title?: string;
  /** Merged ExtendedReceiptSettings for the target document. */
  receiptSettings?: Record<string, unknown> | null;
  /** Printer capability profile (from pos_registers / printer_profiles). */
  capabilities?: {
    auto_cut?: boolean;
    partial_cut?: boolean;
    qr_native?: boolean;
    code128_native?: boolean;
    columns_override?: number;
  } | null;
  /** Per-printer font baseline ("A" | "B"); receipt_settings.font_size wins. */
  font?: "A" | "B";
}

export interface RenderedDocumentEscPos {
  bytes: Uint8Array;
  /** Exact canonical rows encoded into `bytes`. */
  rows: ReceiptLinesResult;
}

export function renderDocumentEscPosWithResult(
  doc: DocumentData,
  opts: RenderDocumentEscPosOptions = {},
): RenderedDocumentEscPos {
  const rows = documentToReceiptLines(doc, {
    width: opts.width,
    title: opts.title,
    receiptSettings: opts.receiptSettings,
    font: opts.font,
    columnsOverride: opts.capabilities?.columns_override,
  });

  const bytes = renderLinesEscPos(rows, {
    caps: {
      qr_native: opts.capabilities?.qr_native ?? true,
      auto_cut: opts.capabilities?.auto_cut ?? true,
      partial_cut: opts.capabilities?.partial_cut ?? true,
      code128_native: opts.capabilities?.code128_native ?? true,
    },
  });
  return { bytes, rows };
}

export function renderDocumentEscPos(
  doc: DocumentData,
  opts: RenderDocumentEscPosOptions = {},
): Uint8Array {
  return renderDocumentEscPosWithResult(doc, opts).bytes;
}
