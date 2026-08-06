/**
 * EditableLineItemsGrid — the ONE editable line-item surface for every
 * transactional document form (Invoice, SO, Estimate, Credit Note,
 * Delivery Note, Return, Bill, PO, GRN …).
 *
 * Phase 8 of the document-workspace consolidation. Create/Edit forms used
 * to ship two hand-rolled renderers each: a `<Table className="min-w-
 * [600px]">` for `sm:` and up, and a duplicated stack of cards below it.
 * The two drifted (fields present in one and missing in the other), and
 * the table scrolled sideways in any narrow container regardless of how
 * many columns the document actually had.
 *
 * This grid shares the measurement engine with the read-only
 * `LineItemsGrid` (`adaptiveColumns.ts`): columns are ranked, the
 * container is measured, and low-priority columns are demoted onto a
 * secondary line — still fully editable — instead of forcing a scrollbar.
 *
 * Rows are rendered by the consumer through `renderRow`, which receives
 * the resolved layout. That keeps per-row memoization intact (critical
 * for the >60 scans/min barcode workflow) while the grid owns the
 * chrome: header, separators, remove affordance, add action and footer.
 */

import { useMemo, type ReactNode } from "react";
import { Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useAdaptiveLayout,
  useContainerWidth,
  DELETE_COL_WIDTH,
  GRID_GAP,
  type AdaptiveColumn,
  type AdaptiveLayout,
} from "./adaptiveColumns";

export type EditableLineColumn = AdaptiveColumn;

/** Layout handed to `renderRow` so the consumer can place its editors. */
export interface EditableRowLayout {
  /** Column ids currently on the primary line, in order. */
  visible: string[];
  /** Column ids demoted to the secondary line, in order. */
  demoted: string[];
  /** `grid-template-columns` for the primary line (excludes the remove cell). */
  gridTemplate: string;
  /** Lookup for a column's descriptor (label, alignment) by id. */
  column: (id: string) => EditableLineColumn | undefined;
}

interface EditableLineItemsGridProps<T> {
  columns: EditableLineColumn[];
  rows: T[];
  /** Stable key per row. Defaults to the row index. */
  rowKey?: (row: T, index: number) => string;
  renderRow: (row: T, index: number, layout: EditableRowLayout) => ReactNode;
  onAddRow?: () => void;
  onRemoveRow?: (index: number) => void;
  /** Defaults to "more than one row remains". */
  canRemoveRow?: (row: T, index: number) => boolean;
  addLabel?: string;
  /** Footer content (totals ladder, line count). */
  footer?: ReactNode;
  /** Rendered above the header — scanners, bulk actions. */
  toolbar?: ReactNode;
  disabled?: boolean;
  empty?: ReactNode;
  className?: string;
  /** Forwarded to the scroll container (scanner flash targets need it). */
  containerRef?: React.Ref<HTMLDivElement>;
}

export function EditableLineItemsGrid<T>({
  columns,
  rows,
  rowKey,
  renderRow,
  onAddRow,
  onRemoveRow,
  canRemoveRow,
  addLabel = "Add line",
  footer,
  toolbar,
  disabled,
  empty = "No lines yet.",
  className,
  containerRef,
}: EditableLineItemsGridProps<T>) {
  const [measureRef, containerWidth] = useContainerWidth<HTMLDivElement>();
  const showRemove = !!onRemoveRow;

  const layout: AdaptiveLayout<EditableLineColumn> = useAdaptiveLayout(
    columns,
    containerWidth,
    showRemove ? DELETE_COL_WIDTH + GRID_GAP : 0,
  );

  // Memoized so `renderRow` consumers keep their per-row memo contract:
  // a new layout object on every parent render would re-render every row
  // and break the O(1)-per-scan guarantee of the barcode workflow.
  const rowLayout: EditableRowLayout = useMemo(
    () => ({
      visible: layout.visible.map((c) => c.id),
      demoted: layout.demoted.map((c) => c.id),
      gridTemplate: layout.visible
        .map(
          (c) => c.width ?? `minmax(${c.minWidth ?? (c.numeric ? 88 : 160)}px, 1fr)`,
        )
        .join(" "),
      column: (id: string) => columns.find((c) => c.id === id),
    }),
    [layout, columns],
  );

  const canRemove = (row: T, index: number) =>
    canRemoveRow ? canRemoveRow(row, index) : rows.length > 1;

  return (
    <div ref={measureRef} className={cn("w-full min-w-0", className)}>
      {toolbar}
      <div
        ref={containerRef}
        className={cn("rounded-md border", layout.needsScroll && "overflow-x-auto")}
      >
        <div className="min-w-0" role="table" aria-rowcount={rows.length}>
          {/* Header */}
          <div
            role="row"
            className="grid items-center gap-2 border-b bg-muted/40 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            style={{ gridTemplateColumns: layout.gridTemplate }}
          >
            {layout.visible.map((c) => (
              <div
                key={c.id}
                role="columnheader"
                className={cn("min-w-0 truncate", c.numeric && "text-right")}
              >
                {c.header}
              </div>
            ))}
            {showRemove && <div aria-hidden />}
          </div>

          {/* Rows */}
          {rows.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              {empty}
            </div>
          ) : (
            <ul className="divide-y">
              {rows.map((row, index) => (
                <li
                  key={rowKey ? rowKey(row, index) : index}
                  role="row"
                  className="grid items-start gap-2 px-3 py-2.5 text-sm"
                  style={{
                    gridTemplateColumns: showRemove
                      ? `minmax(0,1fr) ${DELETE_COL_WIDTH}px`
                      : "minmax(0,1fr)",
                  }}
                >
                  <div className="min-w-0">{renderRow(row, index, rowLayout)}</div>
                  {showRemove && (
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove line"
                        disabled={disabled || !canRemove(row, index)}
                        onClick={() => onRemoveRow?.(index)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {footer && (
            <div className="border-t bg-muted/40 px-3 py-2 text-sm">{footer}</div>
          )}
        </div>
      </div>

      {onAddRow && (
        <div className="mt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onAddRow}
            disabled={disabled}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {addLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Row scaffold for `renderRow` consumers: places the visible cells on the
 * primary grid line and the demoted editors on a labelled secondary line.
 */
export function EditableLineRowCells({
  layout,
  cell,
  extra,
  flashed,
}: {
  layout: EditableRowLayout;
  /** Editor node for a column id. */
  cell: (columnId: string) => ReactNode;
  /** Full-width content below the row (stock status, analytics, tracking). */
  extra?: ReactNode;
  flashed?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-sm transition-colors",
        flashed && "bg-primary/10",
      )}
    >
      <div
        className="grid items-start gap-2"
        style={{ gridTemplateColumns: layout.gridTemplate }}
      >
        {layout.visible.map((id) => {
          const col = layout.column(id);
          return (
            <div key={id} className={cn("min-w-0", col?.numeric && "text-right")}>
              {cell(id)}
            </div>
          );
        })}
      </div>

      {layout.demoted.length > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {layout.demoted.map((id) => {
            const col = layout.column(id);
            return (
              <div key={id} className="min-w-0 space-y-1">
                <span className="block text-[11px] font-medium text-muted-foreground">
                  {col?.compactLabel ?? col?.header}
                </span>
                {cell(id)}
              </div>
            );
          })}
        </div>
      )}

      {extra && <div className="mt-2 min-w-0 space-y-2">{extra}</div>}
    </div>
  );
}
