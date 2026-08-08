/**
 * adaptiveColumns — the shared measurement engine behind every line-item
 * surface in the platform (read-only `LineItemsGrid` and editable
 * `EditableLineItemsGrid`).
 *
 * Layout is a *container* concern, never a viewport concern: the same
 * invoice grid renders inside a full-width object page, a 480px peek
 * drawer and a split-pane form. A `sm:` breakpoint cannot see any of
 * that, so we measure the container and shed columns by retention rank:
 *
 *   priority 1  identity + amount     — never dropped
 *   priority 2  quantity, unit price  — dropped only in very narrow rails
 *   priority 3  discount, tax, UoM    — first to be demoted
 *
 * Demoted columns are not lost — the consuming grid re-renders their
 * value (or their editor) on a secondary line beneath the row's primary
 * cell. Horizontal scroll is a last resort, reported via `needsScroll`.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface AdaptiveColumn {
  id: string;
  header: ReactNode;
  /** Column width. Any CSS grid track syntax. Defaults to `minmax(0,1fr)`. */
  width?: string;
  /** Right-align numeric cells and apply tabular figures. */
  numeric?: boolean;
  /** Retention rank; higher numbers are demoted first. Defaults to 2. */
  priority?: 1 | 2 | 3;
  /** Minimum comfortable width in px, used by the fit calculation. */
  minWidth?: number;
  /** Short label used when the value is demoted into the secondary line. */
  compactLabel?: string;
}

export const GRID_GAP = 8;
export const DELETE_COL_WIDTH = 44;

/** Fallback minimum width for a column that declares none. */
export function minWidthOf(col: AdaptiveColumn): number {
  if (col.minWidth) return col.minWidth;
  if (col.numeric) return 88;
  return 160;
}

/** Observe the rendered width of an element. */
export function useContainerWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  return [ref, width] as const;
}

export interface AdaptiveLayout<C extends AdaptiveColumn> {
  visible: C[];
  demoted: C[];
  needsScroll: boolean;
  /** `grid-template-columns` for both the header and every row. */
  gridTemplate: string;
}

/**
 * Rank and fit `columns` into `containerWidth`.
 *
 * @param reserved px consumed by non-column affordances (delete button).
 */
export function useAdaptiveLayout<C extends AdaptiveColumn>(
  columns: C[],
  containerWidth: number | null,
  reserved = 0,
): AdaptiveLayout<C> {
  return useMemo(() => {
    const available = (containerWidth ?? 0) - reserved;

    const track = (cols: C[]) =>
      [
        ...cols.map((c) => c.width ?? `minmax(${minWidthOf(c)}px, 1fr)`),
        reserved ? `${DELETE_COL_WIDTH}px` : null,
      ]
        .filter(Boolean)
        .join(" ");

    // Before measurement, render the full set: the first paint keeps every
    // column so nothing flashes in and out on a wide screen.
    if (!containerWidth) {
      return {
        visible: columns,
        demoted: [] as C[],
        needsScroll: false,
        gridTemplate: track(columns),
      };
    }

    const fits = (cols: C[]) =>
      cols.reduce((sum, c) => sum + minWidthOf(c), 0) +
        GRID_GAP * Math.max(0, cols.length - 1) <=
      available;

    // Identity (first) and amount (last) are load-bearing: a line item is
    // meaningless without what it is and what it costs.
    const ranked = columns.map((c, i) => ({
      ...c,
      priority: c.priority ?? (i === 0 || i === columns.length - 1 ? 1 : 2),
    })) as C[];

    let kept = [...ranked];
    const dropped: C[] = [];

    for (const priority of [3, 2] as const) {
      // Drop right-to-left within the priority band until the set fits.
      for (let i = kept.length - 1; i >= 0 && !fits(kept); i--) {
        if (kept[i].priority !== priority) continue;
        dropped.unshift(kept[i]);
        kept = kept.filter((_, idx) => idx !== i);
      }
      if (fits(kept)) break;
    }

    // Phone rails (≈330px inside a card) cannot hold identity + amount side
    // by side: 240 + 110 + gap overflows. Rather than force a sideways
    // scrollbar, demote priority-1 columns from the right too — they are
    // still rendered (and still editable) on the secondary line. The first
    // column always stays: it is the row's identity.
    for (let i = kept.length - 1; i >= 1 && !fits(kept); i--) {
      dropped.unshift(kept[i]);
      kept = kept.filter((_, idx) => idx !== i);
    }


    return {
      visible: kept,
      demoted: dropped,
      needsScroll: !fits(kept),
      gridTemplate: track(kept),
    };
  }, [columns, containerWidth, reserved]);
}
