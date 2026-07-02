/**
 * ColumnLayout — pure monospace column solver (Phase A of the receipt
 * rendering overhaul). Shared by the ESC/POS builder and the in-app
 * monospace preview so what you see is what prints.
 *
 * Width units:
 *   - number             → fixed character width
 *   - { fr, min?, max? } → flexible: distributes leftover space proportionally
 *                          to fr after fixed widths are subtracted, clamped
 *                          to [min, max].
 *
 * Algorithm:
 *   1. Sum fixed widths + (cols-1)*gap.
 *   2. Distribute leftover proportionally across fr columns, applying min/max.
 *   3. If still short, shrink the largest fr column to fit (never below its min).
 */

export type Align = "left" | "right" | "center";

export interface ColumnSpec {
  key: string;
  header: string;
  width: number | { fr: number; min?: number; max?: number };
  align: Align;
  /** When true, long values wrap onto subsequent rows (under this column). */
  wrap?: boolean;
}

export interface SolvedColumn extends ColumnSpec {
  resolvedWidth: number;
}

export function solveColumns(
  cols: ColumnSpec[],
  totalCols: number,
  gap = 1,
): SolvedColumn[] {
  if (cols.length === 0) return [];
  const gaps = Math.max(0, cols.length - 1) * gap;
  const available = Math.max(1, totalCols - gaps);

  // Pass 1: fixed widths + collect fr specs.
  const widths: number[] = new Array(cols.length).fill(0);
  let fixedSum = 0;
  let frSum = 0;
  for (let i = 0; i < cols.length; i++) {
    const w = cols[i].width;
    if (typeof w === "number") {
      widths[i] = Math.max(1, Math.floor(w));
      fixedSum += widths[i];
    } else {
      frSum += Math.max(0, w.fr);
    }
  }

  let leftover = Math.max(0, available - fixedSum);

  // Pass 2: distribute fr.
  if (frSum > 0) {
    const frIndices: number[] = [];
    for (let i = 0; i < cols.length; i++) {
      if (typeof cols[i].width !== "number") frIndices.push(i);
    }
    // Initial proportional allocation (floor), then clamp by min/max.
    const raw: number[] = [];
    let allocated = 0;
    for (const i of frIndices) {
      const spec = cols[i].width as { fr: number; min?: number; max?: number };
      let w = Math.floor((leftover * spec.fr) / frSum);
      if (spec.min != null) w = Math.max(w, spec.min);
      if (spec.max != null) w = Math.min(w, spec.max);
      w = Math.max(1, w);
      raw.push(w);
      allocated += w;
    }
    // Distribute remainder one by one to fr columns (left-to-right) up to max.
    let remainder = leftover - allocated;
    let i = 0;
    while (remainder > 0 && frIndices.length > 0) {
      const idx = frIndices[i % frIndices.length];
      const spec = cols[idx].width as { fr: number; min?: number; max?: number };
      const cur = raw[i % frIndices.length];
      if (spec.max == null || cur < spec.max) {
        raw[i % frIndices.length] = cur + 1;
        remainder--;
      }
      i++;
      if (i > frIndices.length * 32) break; // safety
    }
    // If we over-allocated (mins forced it), shrink largest fr down to its min.
    let total = raw.reduce((a, b) => a + b, 0);
    while (total > leftover) {
      let largest = 0;
      for (let k = 1; k < raw.length; k++) if (raw[k] > raw[largest]) largest = k;
      const spec = cols[frIndices[largest]].width as { fr: number; min?: number; max?: number };
      const min = spec.min ?? 1;
      if (raw[largest] <= min) break;
      raw[largest]--;
      total--;
    }
    for (let k = 0; k < frIndices.length; k++) widths[frIndices[k]] = raw[k];
  }

  return cols.map((c, i) => ({ ...c, resolvedWidth: widths[i] }));
}

function padCell(value: string, width: number, align: Align): string {
  if (value.length >= width) return value.slice(0, width);
  const fill = " ".repeat(width - value.length);
  if (align === "right") return fill + value;
  if (align === "center") {
    const l = Math.floor(fill.length / 2);
    return " ".repeat(l) + value + " ".repeat(fill.length - l);
  }
  return value + fill;
}

/**
 * Truncate with ellipsis only when the cell is wider than 4 chars; otherwise
 * hard-truncate (saves one char of payload on tight columns like Qty).
 */
function clip(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 4) return value.slice(0, width);
  return value.slice(0, width - 1) + "…";
}

/**
 * Render one row. Long text in `wrap`-enabled columns produces additional
 * continuation rows where other columns appear empty (preserves vertical
 * column alignment). Returns an array of fully-padded line strings.
 */
export function renderRow(
  values: Record<string, string>,
  cols: SolvedColumn[],
  gap = 1,
): string[] {
  const sep = " ".repeat(gap);
  // For each column compute the visible chunks (wrapped if .wrap; otherwise clipped).
  const chunks: string[][] = cols.map((c) => {
    const raw = values[c.key] ?? "";
    if (!c.wrap) return [clip(raw, c.resolvedWidth)];
    return wordWrap(raw, c.resolvedWidth);
  });
  const rowCount = chunks.reduce((m, ch) => Math.max(m, ch.length), 1);
  const rows: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    const cells = cols.map((c, i) => {
      const cell = chunks[i][r] ?? "";
      return padCell(cell, c.resolvedWidth, c.align);
    });
    rows.push(cells.join(sep));
  }
  return rows;
}

export function renderHeader(cols: SolvedColumn[], gap = 1): string {
  const sep = " ".repeat(gap);
  return cols
    .map((c) => padCell(clip(c.header, c.resolvedWidth), c.resolvedWidth, c.align))
    .join(sep);
}

export function wordWrap(text: string, width: number): string[] {
  if (!text) return [""];
  if (width <= 0) return [""];
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    // Hard-split ultra-long words.
    if (w.length > width) {
      if (cur) { lines.push(cur); cur = ""; }
      let rest = w;
      while (rest.length > width) {
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      cur = rest;
      continue;
    }
    if (!cur) { cur = w; continue; }
    if ((cur + " " + w).length <= width) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Pad two strings to opposite edges of a row of given width. */
export function padLR(left: string, right: string, width: number): string {
  if (left.length + right.length >= width) {
    // Truncate left to fit; never cut the amount on the right.
    const room = Math.max(0, width - right.length - 1);
    return clip(left, room) + " " + right;
  }
  return left + " ".repeat(width - left.length - right.length) + right;
}
