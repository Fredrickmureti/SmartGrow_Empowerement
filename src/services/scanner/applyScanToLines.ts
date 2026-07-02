/**
 * applyScanToLines — shared merge-or-append helper for every module that
 * turns a resolved barcode into a line on a list (POS cart, invoice items,
 * physical count, goods receipt, stock transfer).
 *
 * The original problem: each module rolled its own "find existing line by
 * product_id; if found, increment qty; else append" loop. They diverged
 * subtly (empty-row replacement, qty merge semantics, sort_order handling).
 * One helper, fully typed, with unit tests, kills that drift.
 *
 * The helper is pure: callers pass in the current list and receive a brand
 * new array. No React state, no side effects.
 */

export interface ApplyScanInput<TLine> {
  /** Current list of lines. Not mutated. */
  lines: TLine[];
  /** Match an existing line. Return true to merge into it (qty++). */
  matchLine: (line: TLine) => boolean;
  /**
   * Build a brand-new line when no existing line matches. Receives the
   * resolver's scan quantity (Odoo `n*<barcode>` and weighted EAN both
   * collapse into this single number).
   */
  buildLine: (scanQuantity: number) => TLine;
  /**
   * Produce the patch to apply when merging into an existing line. The
   * helper does NOT assume a `quantity` field name — modules pass their
   * own incrementor so this also works for `counted_qty`,
   * `quantity_to_receive`, etc.
   */
  incrementLine: (existing: TLine, scanQuantity: number) => Partial<TLine>;
  /**
   * Defaults to 1 (one barcode = one unit). POS / Invoice pass through
   * the resolver's `scanQuantity` so weighted-EAN scans contribute the
   * embedded quantity, not a flat 1.
   */
  scanQuantity?: number;
  /**
   * When true, a trailing line for which `matchLine` returns false AND
   * `isEmptyLine` returns true is REPLACED by the new line instead of
   * appended after it. Removes the "always one blank row" UX wart that
   * appears in dialogs that pre-seed an empty line (Create/Edit Invoice,
   * Transfers).
   */
  replaceTrailingEmpty?: boolean;
  /** Required when `replaceTrailingEmpty` is true. */
  isEmptyLine?: (line: TLine) => boolean;
}

export interface ApplyScanResult<TLine> {
  next: TLine[];
  affectedIndex: number;
  mode: "added" | "incremented";
}

export function applyScanToLines<TLine>(
  input: ApplyScanInput<TLine>,
): ApplyScanResult<TLine> {
  const {
    lines,
    matchLine,
    buildLine,
    incrementLine,
    scanQuantity = 1,
    replaceTrailingEmpty = false,
    isEmptyLine,
  } = input;

  const idx = lines.findIndex(matchLine);
  if (idx >= 0) {
    const next = lines.slice();
    next[idx] = { ...lines[idx], ...incrementLine(lines[idx], scanQuantity) };
    return { next, affectedIndex: idx, mode: "incremented" };
  }

  const fresh = buildLine(scanQuantity);

  if (
    replaceTrailingEmpty &&
    isEmptyLine &&
    lines.length > 0 &&
    isEmptyLine(lines[lines.length - 1])
  ) {
    const next = lines.slice(0, -1);
    next.push(fresh);
    return { next, affectedIndex: next.length - 1, mode: "added" };
  }

  const next = lines.slice();
  next.push(fresh);
  return { next, affectedIndex: next.length - 1, mode: "added" };
}