/**
 * Canonical DocumentData -> ReceiptLinesResult adapter.
 *
 * Both thermal PDF and ESC/POS must call this helper rather than rebuilding
 * receipt settings independently. The returned profile is the profile that
 * actually shaped every row, so response headers and persisted metadata can
 * report facts instead of a parallel calculation.
 */
import type { DocumentData } from "../templateRenderer.ts";
import { buildReceiptLines, type ReceiptLinesResult } from "./lines.ts";
import { documentToReceiptInput } from "./documentToInput.ts";
import type { ThermalWidth } from "./resolvePaperWidth.ts";

export interface DocumentToLinesOptions {
  width?: ThermalWidth;
  title?: string;
  receiptSettings?: Record<string, unknown> | null;
  /** Physical printer baseline. Receipt settings normally win. */
  font?: "A" | "B";
  /** A measured column count is the calibration proof for high-density mode. */
  columnsOverride?: number | null;
}

export function documentToReceiptLines(
  doc: DocumentData,
  opts: DocumentToLinesOptions = {},
): ReceiptLinesResult {
  const rs: Record<string, unknown> = { ...(opts.receiptSettings ?? {}) };
  if (opts.width) rs.paper_size = opts.width;

  if (opts.columnsOverride != null && opts.columnsOverride > 0) {
    rs.columns_override = Math.floor(opts.columnsOverride);
  }

  if (opts.font && !rs.font_size) {
    rs.font_size = opts.font === "B" ? "small" : "medium";
  }

  // Enterprise-safe 58 mm baseline: high-density Font B varies across
  // emulators and low-cost ESC/POS firmware. It is enabled only together
  // with an explicitly measured column count. Otherwise use Font A / 32.
  const requestedFontB = rs.font_size === "small" || opts.font === "B";
  const hasMeasuredColumns =
    typeof rs.columns_override === "number" && rs.columns_override > 0;
  if (rs.paper_size === "58mm" && requestedFontB && !hasMeasuredColumns) {
    rs.font_size = "medium";
  }

  return buildReceiptLines(documentToReceiptInput(doc, {
    settings: rs,
    title: opts.title,
  }));
}