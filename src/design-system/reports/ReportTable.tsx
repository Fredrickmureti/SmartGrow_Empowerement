/**
 * ReportTable — the canonical financial table for every report in the ERP.
 *
 * One implementation owns the things that used to be re-invented on each of
 * the ~19 report pages: numeric alignment and tabular figures, section /
 * subtotal / grand-total hierarchy, depth indentation, column-group rules,
 * sticky headers and sticky label columns for wide reports, row guides
 * tuned for long reading sessions and grayscale printing, and windowed
 * rendering so a 100k-line ledger scrolls instead of freezing the tab.
 *
 * Pages declare columns + rows (see `model.ts`) and nothing else.
 */
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { cn } from "@/lib/utils";
import { formatReportValue } from "./format";
import {
  columnAlign,
  isNumericColumn,
  type ReportColumn,
  type ReportColumnGroup,
  type ReportRow,
} from "./model";

export interface ReportTableProps {
  columns: ReportColumn<never>[];
  rows: ReportRow[];
  /** Optional header tier above the columns (Opening / Movement / Closing). */
  columnGroups?: ReportColumnGroup[];
  currency?: string | null;
  /** Max viewport height for the scroll area. Defaults to a tall pane. */
  maxHeight?: number;
  /** Row count above which windowed rendering kicks in. */
  virtualizeAbove?: number;
  /** Rendered when `rows` is empty. */
  emptyMessage?: string;
  caption?: string;
  className?: string;
}

const ROW_HEIGHT = 33;
const OVERSCAN = 12;

const ALIGN_CLASS = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
} as const;

const TONE_CLASS = {
  default: "",
  warning: "text-warning",
  danger: "text-destructive",
  success: "text-success",
} as const;

export function ReportTable({
  columns,
  rows,
  columnGroups,
  currency,
  maxHeight = 720,
  virtualizeAbove = 400,
  emptyMessage = "No rows for the selected criteria",
  caption,
  className,
}: ReportTableProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(maxHeight);

  const virtualized = rows.length > virtualizeAbove;

  const onScroll = useCallback(() => {
    if (!virtualized) return;
    setScrollTop(scrollRef.current?.scrollTop ?? 0);
  }, [virtualized]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewport(el.clientHeight || maxHeight);
  }, [maxHeight, rows.length]);

  const { visible, padTop, padBottom } = useMemo(() => {
    if (!virtualized) return { visible: rows, padTop: 0, padBottom: 0 };
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const count = Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN * 2;
    const last = Math.min(rows.length, first + count);
    return {
      visible: rows.slice(first, last),
      padTop: first * ROW_HEIGHT,
      padBottom: (rows.length - last) * ROW_HEIGHT,
    };
  }, [rows, virtualized, scrollTop, viewport]);

  /** Left offset (px) for each sticky column, accumulated in order. */
  const stickyOffsets = useMemo(() => {
    const offsets: Record<number, number> = {};
    let acc = 0;
    columns.forEach((col, i) => {
      if (!col.sticky) return;
      offsets[i] = acc;
      acc += parseWidth(col.width) ?? 160;
    });
    return offsets;
  }, [columns]);

  if (rows.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">{emptyMessage}</p>
    );
  }

  const leadSpan = columns.filter((c) => !isNumericColumn(c)).length || 1;

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={cn(
        "relative overflow-auto print:overflow-visible print:max-h-none",
        className,
      )}
      style={{ maxHeight }}
    >
      <table className="w-full border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}

        <thead className="sticky top-0 z-20 bg-card">
          {columnGroups && columnGroups.length > 0 && (
            <tr>
              {columnGroups.map((group, i) => (
                <th
                  key={`${group.label}-${i}`}
                  colSpan={group.span}
                  scope="colgroup"
                  className={cn(
                    "border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
                    ALIGN_CLASS[group.align ?? "center"],
                    i < columnGroups.length - 1 && "border-r border-border",
                  )}
                >
                  {group.label}
                </th>
              ))}
            </tr>
          )}
          <tr>
            {columns.map((col, i) => (
              <th
                key={col.key}
                scope="col"
                style={stickyStyle(col, stickyOffsets[i])}
                className={cn(
                  "border-b-2 border-border bg-card px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
                  ALIGN_CLASS[columnAlign(col)],
                  col.width,
                  col.groupEnd && "border-r border-border",
                  col.secondary && "hidden md:table-cell",
                  col.sticky && "sticky z-10",
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {padTop > 0 && (
            <tr aria-hidden style={{ height: padTop }}>
              <td colSpan={columns.length} />
            </tr>
          )}

          {visible.map((row) => {
            const kind = row.kind ?? "detail";

            if (kind === "spacer") {
              return (
                <tr key={row.id} aria-hidden>
                  <td colSpan={columns.length} className="h-3" />
                </tr>
              );
            }

            if (kind === "section") {
              return (
                <tr key={row.id} className="bg-muted/60">
                  <th
                    scope="rowgroup"
                    colSpan={columns.length}
                    className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-foreground"
                  >
                    {row.label}
                  </th>
                </tr>
              );
            }

            const isSubtotal = kind === "subtotal";
            const isGrand = kind === "grandTotal";
            const totalRow = isSubtotal || isGrand;

            return (
              <tr
                key={row.id}
                onClick={row.onClick}
                className={cn(
                  "border-b border-border/40",
                  !totalRow && "odd:bg-muted/[0.18]",
                  row.onClick && "cursor-pointer hover:bg-accent/40",
                  isSubtotal && "border-t border-border font-medium bg-muted/30",
                  isGrand && "border-t-2 border-b-2 border-foreground/60 bg-muted font-semibold",
                  TONE_CLASS[row.tone ?? "default"],
                )}
              >
                {totalRow ? (
                  <>
                    <td
                      colSpan={leadSpan}
                      className={cn(
                        "px-3 py-1.5 text-right",
                        columns[leadSpan - 1]?.groupEnd && "border-r border-border",
                      )}
                    >
                      {row.label}
                    </td>
                    {columns.slice(leadSpan).map((col, i) => (
                      <Cell
                        key={col.key}
                        col={col}
                        row={row}
                        currency={currency}
                        stickyLeft={stickyOffsets[leadSpan + i]}
                      />
                    ))}
                  </>
                ) : (
                  columns.map((col, i) => (
                    <Cell
                      key={col.key}
                      col={col}
                      row={row}
                      currency={currency}
                      stickyLeft={stickyOffsets[i]}
                      indent={i === 0 ? row.depth : undefined}
                    />
                  ))
                )}
              </tr>
            );
          })}

          {padBottom > 0 && (
            <tr aria-hidden style={{ height: padBottom }}>
              <td colSpan={columns.length} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

interface CellProps {
  col: ReportColumn<never>;
  row: ReportRow;
  currency?: string | null;
  stickyLeft?: number;
  indent?: number;
}

function Cell({ col, row, currency, stickyLeft, indent }: CellProps) {
  const numeric = isNumericColumn(col);
  const raw = row.values?.[col.key];
  const content = col.render
    ? col.render(row as never)
    : formatReportValue(raw, col.format ?? "text", currency);

  return (
    <td
      style={{
        ...stickyStyle(col, stickyLeft),
        ...(indent ? { paddingLeft: 12 + indent * 14 } : null),
      }}
      className={cn(
        "px-3 py-1.5 align-top",
        ALIGN_CLASS[columnAlign(col)],
        numeric && "tabular-nums whitespace-nowrap",
        col.groupEnd && "border-r border-border",
        col.secondary && "hidden md:table-cell",
        col.sticky && "sticky z-10 bg-inherit",
      )}
    >
      {content}
    </td>
  );
}

function stickyStyle(
  col: ReportColumn<never>,
  left: number | undefined,
): CSSProperties | undefined {
  if (!col.sticky || left === undefined) return undefined;
  return { left };
}

function parseWidth(width?: string): number | null {
  if (!width) return null;
  const match = /\[(\d+)px\]/.exec(width);
  return match ? Number(match[1]) : null;
}
