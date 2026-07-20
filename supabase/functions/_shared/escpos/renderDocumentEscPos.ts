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
 * Callers in `generate-document/index.ts` use this instead of
 * `buildDocumentEscPos` (which remains alive for kitchen tickets and
 * legacy byte-golden tests only).
 */

import type { DocumentData } from "../templateRenderer.ts";
import { buildReceiptLines } from "../receipt/lines.ts";
import { documentToReceiptInput } from "../receipt/documentToInput.ts";
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

export function renderDocumentEscPos(
  doc: DocumentData,
  opts: RenderDocumentEscPosOptions = {},
): Uint8Array {
  const rs: Record<string, unknown> = {
    ...(opts.receiptSettings ?? {}),
  };

  // Pin the engine's paper width to the caller's resolved thermal width so
  // the row producer, PDF and ESC/POS stream all share one column grid.
  if (opts.width) rs.paper_size = opts.width;

  // Honor a per-printer font baseline when receipt_settings did not set one.
  if (opts.font && !rs.font_size) {
    rs.font_size = opts.font === "B" ? "small" : "medium";
  }

  // Honor caller-supplied column override (from printer_profiles).
  if (opts.capabilities?.columns_override != null && rs.columns_override == null) {
    rs.columns_override = opts.capabilities.columns_override;
  }

  const input = documentToReceiptInput(doc, {
    settings: rs,
    title: opts.title,
  });

  const rows = buildReceiptLines(input);

  // Emitter-level policy: copies × body, cut mode, feed lines. These are
  // document-level directives (not row properties) so they belong in the
  // emitter, not the row producer.
  const copies = clampInt(rs.copies as number | undefined, 1, 1, 3);
  const cutMode = (rs.cut_mode as string | undefined) ?? "full";
  const feed = clampInt(rs.feed_lines_after as number | undefined, 4, 0, 10);
  const copyLabels = Array.isArray(rs.copy_labels)
    ? (rs.copy_labels as unknown[]).map((s) => String(s ?? ""))
    : [];

  const caps = {
    qr_native: opts.capabilities?.qr_native ?? true,
    auto_cut:
      cutMode === "none"
        ? false
        : (opts.capabilities?.auto_cut ?? true),
  };

  const chunks: Uint8Array[] = [];
  for (let i = 0; i < copies; i++) {
    // If a copy label is provided, splice it into the header of this copy.
    const label = copyLabels[i]?.trim();
    let copyRows = rows;
    if (label) {
      copyRows = {
        ...rows,
        lines: [label, ...rows.lines],
        meta: [{ align: "center", bold: true }, ...rows.meta],
      };
    }
    const isLast = i === copies - 1;
    chunks.push(
      renderLinesEscPos(copyRows, {
        caps,
        // Only cut after the final copy — otherwise multi-copy prints
        // tear off between duplicates.
        cut: isLast && cutMode !== "none",
        feedLinesAfter: feed,
      }),
    );
  }

  return concat(chunks);
}

function clampInt(
  v: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
  return Math.max(min, Math.min(max, n));
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
