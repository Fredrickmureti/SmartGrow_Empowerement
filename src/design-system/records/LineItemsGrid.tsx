/**
 * LineItemsGrid — the ONE line-item renderer for every transactional
 * document in the platform (Invoice, SO, Estimate, Credit Note, Delivery
 * Note, Return, Recurring, Proforma, Bill, PO, GRN …).
 *
 * Adaptive by container, not by viewport
 * -------------------------------------
 * The previous implementation wrapped the grid in `overflow-x-auto` around a
 * hard `min-w-[720px]`, so a three-column delivery-note grid scrolled
 * sideways inside a peek drawer exactly as much as a nine-column invoice.
 * The constraint is the *container*, never the screen, so this version
 * measures the container and ranks columns:
 *
 *   priority 1  identity + amount    — never dropped
 *   priority 2  quantity, unit price — dropped only in very narrow rails
 *   priority 3  discount, tax, UoM   — first to be demoted
 *
 * Demoted columns are not lost: their values render as a compact secondary
 * line under the row's primary cell, so the drawer keeps the information
 * while shedding the horizontal axis. Horizontal scroll only ever appears
 * when even the priority-1 set cannot fit — a genuine last resort.
 *
 * Presentational only; the parent form owns mutation.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface LineItemColumn {
  id: string;
  header: ReactNode;
  /** Column width. Any CSS grid track syntax. Defaults to `minmax(0,1fr)`. */
  width?: string;
  /** Right-align numeric cells and apply tabular figures. */
  numeric?: boolean;
  /**
   * Retention rank. 1 = always visible (identity, amount), 2 = important
   * (qty, unit price), 3 = supporting (discount, tax, UoM). Higher numbers
   * are demoted into the row's secondary line first. Defaults to 2.
   */
  priority?: 1 | 2 | 3;
  /** Minimum comfortable width in px, used by the fit calculation. */
  minWidth?: number;
  /** Short label used when the value is demoted into the secondary line. */
  compactLabel?: string;
}

export interface LineItemRowCell {
  columnId: string;
  content: ReactNode;
}

export interface LineItemRow {
  id: string;
  cells: LineItemRowCell[];
}

interface LineItemsGridProps {
  columns: LineItemColumn[];
  rows: LineItemRow[];
  onAddRow?: () => void;
  onRemoveRow?: (id: string) => void;
  addLabel?: string;
  /** Sticky footer content (document totals, line count). */
  footer?: ReactNode;
  className?: string;
  /** Read-only display (posted documents, peek surfaces). */
  readOnly?: boolean;
  /** Empty-state copy. */
  empty?: ReactNode;
}

const DELETE_COL_WIDTH = 44;
const GAP = 8;

/** Fallback minimum width for a column that declares none. */
function minWidthOf(col: LineItemColumn): number {
  if (col.minWidth) return col.minWidth;
  if (col.numeric) return 88;
  return 160;
}

/** Observe the rendered width of an element. */
function useContainerWidth<T extends HTMLElement>() {
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

export function LineItemsGrid({
  columns,
  rows,
  onAddRow,
  onRemoveRow,
  addLabel = "Add line",
  footer,
  className,
  readOnly = false,
  empty = "No lines yet.",
}: LineItemsGridProps) {
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>();
  const showDelete = !readOnly && !!onRemoveRow;

  /**
   * Decide which columns survive at the measured width. Columns are dropped
   * from the lowest priority (3) upwards, and within a priority from the
   * right, mirroring how ERP grids shed supporting detail.
   */
  const { visible, demoted, needsScroll } = useMemo(() => {
    const reserved = showDelete ? DELETE_COL_WIDTH + GAP : 0;
    const available = (containerWidth ?? 0) - reserved;

    // Before measurement, render the full set: SSR and the first paint keep
    // every column so nothing flashes in and out on a wide screen.
    if (!containerWidth) {
      return { visible: columns, demoted: [] as LineItemColumn[], needsScroll: false };
    }

    const fits = (cols: LineItemColumn[]) =>
      cols.reduce((sum, c) => sum + minWidthOf(c), 0) + GAP * Math.max(0, cols.length - 1) <=
      available;

    // Identity (first) and amount (last) are load-bearing: a line item is
    // meaningless without what it is and what it costs.
    const ranked = columns.map((c, i) => ({
      ...c,
      priority: c.priority ?? (i === 0 || i === columns.length - 1 ? 1 : 2),
    }));

    let kept = [...ranked];
    const dropped: LineItemColumn[] = [];

    for (const priority of [3, 2] as const) {
      // Drop right-to-left within the priority band until the set fits.
      for (let i = kept.length - 1; i >= 0 && !fits(kept); i--) {
        if (kept[i].priority !== priority) continue;
        dropped.unshift(kept[i]);
        kept = kept.filter((_, idx) => idx !== i);
      }
      if (fits(kept)) break;
    }

    return { visible: kept, demoted: dropped, needsScroll: !fits(kept) };
  }, [columns, containerWidth, showDelete]);

  const gridTemplate = useMemo(
    () =>
      [
        ...visible.map((c) => c.width ?? `minmax(${minWidthOf(c)}px, 1fr)`),
        showDelete ? `${DELETE_COL_WIDTH}px` : null,
      ]
        .filter(Boolean)
        .join(" "),
    [visible, showDelete],
  );

  /** The column a demoted value hangs beneath — the first visible column. */
  const anchorId = visible[0]?.id;

  const body = (
    <div
      className={cn("min-w-0", needsScroll && "min-w-[560px]")}
      role="table"
      aria-rowcount={rows.length}
    >
      {/* Header */}
      <div
        role="row"
        className="sticky top-0 z-10 grid items-center gap-2 border-b bg-muted/40 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {visible.map((c) => (
          <div
            key={c.id}
            role="columnheader"
            className={cn("min-w-0 truncate", c.numeric && "text-right")}
          >
            {c.header}
          </div>
        ))}
        {showDelete && <div aria-hidden />}
      </div>

      {/* Rows */}
      {rows.length === 0 ? (
        <div className="px-3 py-8 text-center text-sm text-muted-foreground">
          {empty}
        </div>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => {
            const cellFor = (id: string) => row.cells.find((c) => c.columnId === id);
            const secondary = demoted
              .map((col) => ({ col, cell: cellFor(col.id) }))
              .filter(({ cell }) => cell?.content != null && cell.content !== "");

            return (
              <li
                key={row.id}
                role="row"
                className="grid items-start gap-2 px-3 py-2.5 text-sm transition-colors hover:bg-muted/30"
                style={{ gridTemplateColumns: gridTemplate }}
              >
                {visible.map((col) => {
                  const cell = cellFor(col.id);
                  const isAnchor = col.id === anchorId;
                  return (
                    <div
                      key={col.id}
                      role="cell"
                      className={cn(
                        "min-w-0",
                        col.numeric && "text-right tabular-nums",
                      )}
                    >
                      <div
                        className={cn(!col.numeric && "truncate")}
                        title={typeof cell?.content === "string" ? cell.content : undefined}
                      >
                        {cell?.content ?? <span className="text-muted-foreground">—</span>}
                      </div>
                      {isAnchor && secondary.length > 0 && (
                        <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                          {secondary.map(({ col: dc, cell: dcell }) => (
                            <div key={dc.id} className="flex gap-1">
                              <dt>{dc.compactLabel ?? dc.header}</dt>
                              <dd className="tabular-nums text-foreground/80">
                                {dcell?.content}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </div>
                  );
                })}
                {showDelete && (
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove line"
                      onClick={() => onRemoveRow?.(row.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {footer && (
        <div className="sticky bottom-0 border-t bg-muted/40 px-3 py-2 text-sm backdrop-blur">
          {footer}
        </div>
      )}
    </div>
  );

  return (
    <div ref={containerRef} className={cn("w-full min-w-0", className)}>
      <div className={cn("rounded-md border", needsScroll && "overflow-x-auto")}>
        {body}
      </div>

      {!readOnly && onAddRow && (
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={onAddRow}>
            <Plus className="mr-1.5 h-4 w-4" />
            {addLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
