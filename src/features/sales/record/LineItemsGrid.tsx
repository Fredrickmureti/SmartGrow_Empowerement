/**
 * Sales — line-item grid primitive.
 *
 * Inline row-edit grid used by every line-based Sales record: Invoice, SO,
 * Estimate, Credit Note, Delivery Note, Sales Return, Recurring Invoice,
 * Proforma. Presentational only — the parent form owns the mutation.
 *
 * Column contract (per row):
 *   [ product ] [ description ] [ qty ] [ uom ] [ unit price ]
 *   [ discount ] [ tax ] [ subtotal ]                [ delete ]
 *
 * Consumers pass a `columns` config describing which cells to render, and
 * per-row values via `rows`. The grid handles keyboard focus, wrapping,
 * and consistent alignment (numeric columns tabular-right).
 */

import type { ReactNode } from "react";
import { Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface LineItemColumn {
  id: string;
  header: ReactNode;
  /** Column width. "auto" fills. Any CSS grid track syntax also works. */
  width?: string;
  /** Right-align numeric cells. */
  numeric?: boolean;
  /** Hide on narrow screens. */
  hideOnMobile?: boolean;
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
  /** Optional label for the "Add line" button. */
  addLabel?: string;
  /** Optional footer row (totals, etc.). */
  footer?: ReactNode;
  className?: string;
  /** Read-only display (posted invoices, historical records). */
  readOnly?: boolean;
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
}: LineItemsGridProps) {
  const showDelete = !readOnly && !!onRemoveRow;
  const gridTemplate = [
    ...columns.map((c) => c.width ?? "minmax(0, 1fr)"),
    showDelete ? "44px" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cn("w-full", className)}>
      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          {/* Header */}
          <div
            className="grid items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {columns.map((c) => (
              <div
                key={c.id}
                className={cn(
                  "min-w-0 truncate",
                  c.numeric && "text-right",
                  c.hideOnMobile && "hidden sm:block",
                )}
              >
                {c.header}
              </div>
            ))}
            {showDelete && <div aria-hidden />}
          </div>

          {/* Rows */}
          {rows.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              No lines yet.
            </div>
          ) : (
            <ul className="divide-y">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="grid items-center gap-2 px-3 py-2 hover:bg-muted/20"
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  {columns.map((col) => {
                    const cell = row.cells.find((c) => c.columnId === col.id);
                    return (
                      <div
                        key={col.id}
                        className={cn(
                          "min-w-0",
                          col.numeric && "text-right tabular-nums",
                          col.hideOnMobile && "hidden sm:block",
                        )}
                      >
                        {cell?.content ?? (
                          <span className="text-muted-foreground">—</span>
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
              ))}
            </ul>
          )}

          {footer && <div className="border-t px-3 py-2">{footer}</div>}
        </div>
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
