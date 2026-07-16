/**
 * GridDesigner — spreadsheet-style visual editor for v4 `grid` nodes.
 *
 * Renders header / data / footer rows in their true visual layout with
 * colspan + rowspan applied, so the publisher edits the table the way it
 * will render on the filed certificate. A cell click selects it and opens
 * the inspector strip below; column widths are dragged from the ruler on
 * top; header/footer rows are added/removed inline; cells merge right
 * (colspan +1) or down (rowspan +1) with dedicated toolbar buttons.
 *
 * This is Phase C of the certificate publishing architecture revision —
 * the piece the user explicitly called out ("like Excel: define columns,
 * see spans, don't pick columns and hope"). Legacy form-based controls
 * remain for grid-wide settings (border, zebra, data-row bind, repeat
 * header) at the top of the panel.
 */
import { useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Plus, Trash2, ArrowLeftRight, ArrowUpDown, RotateCcw, Sigma, MoveHorizontal,
} from "lucide-react";
import { ValueEditor, VALUE_FORMATS } from "./CertificateV3Editor";

// ── Types (kept structural — mirrors AST) ────────────────────────────────

type Value =
  | { kind: "literal"; value: string | number }
  | { kind: "binding"; path: string; format?: string; fallback?: string }
  | { kind: "sum_of"; column_id: string };

interface GridColumn {
  id: string;
  width?: number | string; // mm number, or fr string like "1fr"
  align?: "left" | "center" | "right";
  format?: string;
  nowrap?: boolean;
  bind_key?: string;
}
interface GridCell {
  span?: number;
  row_span?: number;
  content: Value;
  variant?: "plain" | "label" | "unit" | "letter" | "note" | "total";
  align?: "left" | "center" | "right";
}
type GridRow = GridCell[];

const CELL_VARIANTS = ["plain", "label", "unit", "letter", "note", "total"] as const;
const BORDER_MODES = ["all", "outer", "none"] as const;
const ZEBRA_MODES = ["none", "even", "odd"] as const;
const ALIGN_OPTIONS = ["left", "center", "right"] as const;

// ── Occupancy layout ─────────────────────────────────────────────────────
// Because rowSpan cells span downward rows, we resolve which visual
// (row,col) each authored cell occupies. This lets us render <td> in
// the correct places and skip cells that are covered.
interface Placed {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  rowIdx: number;  // index into the authored rows array
  cellIdx: number; // index into the authored row's cells
}

function layoutRows(rows: GridRow[], numCols: number): {
  placed: Placed[];
  totalRows: number;
} {
  const grid: boolean[][] = [];
  const placed: Placed[] = [];
  const ensure = (r: number) => { while (grid.length <= r) grid.push(new Array(numCols).fill(false)); };

  rows.forEach((row, rowIdx) => {
    ensure(rowIdx);
    let col = 0;
    (row ?? []).forEach((cell, cellIdx) => {
      // advance past occupied cells
      while (col < numCols && grid[rowIdx][col]) col++;
      if (col >= numCols) return;
      const colSpan = Math.max(1, Math.min(numCols - col, cell.span ?? 1));
      const rowSpan = Math.max(1, cell.row_span ?? 1);
      for (let r = 0; r < rowSpan; r++) {
        ensure(rowIdx + r);
        for (let c = 0; c < colSpan; c++) {
          grid[rowIdx + r][col + c] = true;
        }
      }
      placed.push({ row: rowIdx, col, rowSpan, colSpan, rowIdx, cellIdx });
      col += colSpan;
    });
  });
  return { placed, totalRows: Math.max(rows.length, grid.length) };
}

// ── Selection ────────────────────────────────────────────────────────────
type Selection =
  | { band: "header" | "footer"; rowIdx: number; cellIdx: number }
  | null;

// ── Component ────────────────────────────────────────────────────────────

export function GridDesigner({ node, onChange }: { node: any; onChange: (n: any) => void }) {
  const set = (patch: any) => onChange({ ...node, ...patch });
  const cols: GridColumn[] = node.columns ?? [];
  const headerRows: GridRow[] = node.header_rows ?? [];
  const footerRows: GridRow[] = node.footer_rows ?? [];
  const dataRows = node.data_rows ?? { bind: "" };
  const [selection, setSelection] = useState<Selection>(null);

  const columnIds = useMemo(() => cols.map((c) => c.id).filter(Boolean), [cols]);

  // ── Column ops ─────────────────────────────────────────────────────────
  const patchCol = (i: number, next: GridColumn) => { const c = [...cols]; c[i] = next; set({ columns: c }); };
  const addCol = () => {
    const newCol: GridColumn = { id: `col_${cols.length + 1}`, align: "right", format: "number" };
    set({ columns: [...cols, newCol] });
  };
  const removeCol = (i: number) => {
    // Also trim any header/footer cells whose span would now overflow.
    // (Cells stay; layout clamps span.) Simplest: just drop the column.
    if (!confirm(`Remove column "${cols[i]?.id}"? Any header/footer cells will move over.`)) return;
    set({ columns: cols.filter((_, idx) => idx !== i) });
  };

  // ── Row / cell ops ─────────────────────────────────────────────────────
  const bandRows = (band: "header" | "footer") => band === "header" ? headerRows : footerRows;
  const setBandRows = (band: "header" | "footer", next: GridRow[]) =>
    set(band === "header" ? { header_rows: next } : { footer_rows: next });

  const addRow = (band: "header" | "footer") => {
    const rows = bandRows(band);
    // seed one plain cell spanning all columns so the grid stays valid
    const seed: GridCell = { span: cols.length || 1, content: { kind: "literal", value: "" }, variant: "plain" };
    setBandRows(band, [...rows, [seed]]);
  };
  const removeRow = (band: "header" | "footer", rowIdx: number) => {
    const rows = bandRows(band).filter((_, i) => i !== rowIdx);
    setBandRows(band, rows);
    setSelection(null);
  };
  const patchCell = (band: "header" | "footer", rowIdx: number, cellIdx: number, next: GridCell) => {
    const rows = bandRows(band).map((r) => [...r]);
    rows[rowIdx][cellIdx] = next;
    setBandRows(band, rows);
  };
  const removeCell = (band: "header" | "footer", rowIdx: number, cellIdx: number) => {
    const rows = bandRows(band).map((r, i) => i === rowIdx ? r.filter((_, j) => j !== cellIdx) : r);
    setBandRows(band, rows);
    setSelection(null);
  };
  const addCellToRow = (band: "header" | "footer", rowIdx: number) => {
    const rows = bandRows(band).map((r) => [...r]);
    rows[rowIdx] = [...rows[rowIdx], { span: 1, content: { kind: "literal", value: "" }, variant: "plain" }];
    setBandRows(band, rows);
  };
  const adjustSpan = (band: "header" | "footer", rowIdx: number, cellIdx: number, key: "span" | "row_span", delta: number) => {
    const rows = bandRows(band);
    const cell = rows[rowIdx]?.[cellIdx];
    if (!cell) return;
    const next = Math.max(1, (cell[key] ?? 1) + delta);
    patchCell(band, rowIdx, cellIdx, { ...cell, [key]: next });
  };

  // ── Column width drag ──────────────────────────────────────────────────
  const dragState = useRef<{ i: number; startX: number; startWidth: number } | null>(null);
  const onWidthDragStart = (i: number, ev: React.PointerEvent) => {
    const cur = cols[i]?.width;
    const startWidth = typeof cur === "number" ? cur : 30; // default 30mm handle
    dragState.current = { i, startX: ev.clientX, startWidth };
    (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
  };
  const onWidthDragMove = (ev: React.PointerEvent) => {
    const st = dragState.current;
    if (!st) return;
    const dx = ev.clientX - st.startX;
    // 1px screen ≈ ~0.25mm scale — publisher wants direction, not precision
    const next = Math.max(8, Math.round(st.startWidth + dx * 0.25));
    patchCol(st.i, { ...cols[st.i], width: next });
  };
  const onWidthDragEnd = (ev: React.PointerEvent) => {
    dragState.current = null;
    (ev.target as HTMLElement).releasePointerCapture?.(ev.pointerId);
  };

  const numCols = cols.length;
  const headerLayout = useMemo(() => layoutRows(headerRows, numCols), [headerRows, numCols]);
  const footerLayout = useMemo(() => layoutRows(footerRows, numCols), [footerRows, numCols]);

  const selectedCell: GridCell | null = selection
    ? (bandRows(selection.band)[selection.rowIdx]?.[selection.cellIdx] ?? null)
    : null;

  const colTemplate = cols.map((c) => {
    if (typeof c.width === "number") return `${c.width}mm`;
    if (typeof c.width === "string" && c.width) return c.width;
    return "minmax(24mm, 1fr)";
  }).join(" ");

  // ── Render helpers ─────────────────────────────────────────────────────
  const renderBand = (band: "header" | "footer") => {
    const rows = bandRows(band);
    const { placed, totalRows } = band === "header" ? headerLayout : footerLayout;
    if (numCols === 0) {
      return (
        <div className="text-[11px] text-muted-foreground italic p-2">
          Add at least one column above to design the {band}.
        </div>
      );
    }
    return (
      <div className="overflow-x-auto">
        <div
          className="inline-grid text-[11px] border border-border/80 bg-background"
          style={{
            gridTemplateColumns: colTemplate,
            gridTemplateRows: `repeat(${Math.max(1, totalRows)}, minmax(28px, auto))`,
            minWidth: numCols * 40,
          }}
        >
          {placed.map((p) => {
            const cell = rows[p.rowIdx]?.[p.cellIdx];
            if (!cell) return null;
            const isSel = selection?.band === band && selection.rowIdx === p.rowIdx && selection.cellIdx === p.cellIdx;
            const isSum = cell.content && (cell.content as any).kind === "sum_of";
            const label = isSum
              ? `Σ ${(cell.content as any).column_id ?? "?"}`
              : (cell.content as any).kind === "binding"
                ? `{{${(cell.content as any).path || "…"}}}`
                : String((cell.content as any).value ?? "");
            return (
              <button
                type="button"
                key={`${p.rowIdx}-${p.cellIdx}`}
                onClick={() => setSelection({ band, rowIdx: p.rowIdx, cellIdx: p.cellIdx })}
                className={[
                  "text-left px-1.5 py-1 border-r border-b border-border/60 truncate transition-colors",
                  "hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/60",
                  isSel ? "bg-primary/10 ring-1 ring-primary" : "",
                  variantClass(cell.variant),
                ].join(" ")}
                style={{
                  gridColumn: `${p.col + 1} / span ${p.colSpan}`,
                  gridRow: `${p.row + 1} / span ${p.rowSpan}`,
                  textAlign: cell.align ?? "left",
                }}
                title={label}
              >
                {label || <span className="text-muted-foreground italic">empty</span>}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {/* Grid-wide controls */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-[10px]">Title</Label>
          <ValueEditor value={node.title} onChange={(v) => set({ title: v })} placeholder="Grid title" />
        </div>
        <div>
          <Label className="text-[10px]">Data rows — bind (array path)</Label>
          <Input
            className="h-7 text-xs font-mono"
            value={dataRows.bind ?? ""}
            onChange={(e) => set({ data_rows: { ...dataRows, bind: e.target.value } })}
            placeholder="e.g. rows.items"
          />
        </div>
        <div>
          <Label className="text-[10px]">Border</Label>
          <Select value={node.border ?? "all"} onValueChange={(b) => set({ border: b })}>
            <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>{BORDER_MODES.map((b) => <SelectItem key={b} value={b} className="text-xs">{b}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-[10px]">Zebra</Label>
          <Select value={node.zebra ?? "none"} onValueChange={(z) => set({ zebra: z })}>
            <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>{ZEBRA_MODES.map((z) => <SelectItem key={z} value={z} className="text-xs">{z}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>

      {/* Column ruler + list */}
      <div className="rounded border">
        <div className="px-2 py-1 border-b flex items-center justify-between bg-muted/40">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Columns · {cols.length}</span>
          <Button type="button" size="sm" variant="outline" className="h-6 text-[10px]" onClick={addCol}>
            <Plus className="h-3 w-3 mr-1" />Add column
          </Button>
        </div>
        <div className="overflow-x-auto p-2 space-y-1">
          {/* Ruler with draggable width handles */}
          {numCols > 0 && (
            <div
              className="inline-grid text-[10px] mb-1"
              style={{ gridTemplateColumns: colTemplate, minWidth: numCols * 40 }}
            >
              {cols.map((c, i) => (
                <div key={i} className="relative border border-border/50 bg-muted/20 px-1 py-0.5 flex items-center justify-between">
                  <span className="font-mono truncate">{c.id || `col_${i + 1}`}</span>
                  <span className="text-muted-foreground">
                    {typeof c.width === "number" ? `${c.width}mm` : (c.width || "auto")}
                  </span>
                  <div
                    role="separator"
                    aria-label={`Resize column ${c.id}`}
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/60"
                    onPointerDown={(e) => onWidthDragStart(i, e)}
                    onPointerMove={onWidthDragMove}
                    onPointerUp={onWidthDragEnd}
                  />
                </div>
              ))}
            </div>
          )}
          {/* Per-column inspector rows */}
          {cols.map((c, i) => (
            <div key={i} className="grid grid-cols-[80px_60px_70px_1fr_28px] gap-1 items-center">
              <Input className="h-7 text-[11px] font-mono" value={c.id ?? ""}
                onChange={(e) => patchCol(i, { ...c, id: e.target.value })} placeholder="id" />
              <Select value={c.align ?? "right"} onValueChange={(a) => patchCol(i, { ...c, align: a as any })}>
                <SelectTrigger className="h-7 text-[10px] px-1"><SelectValue /></SelectTrigger>
                <SelectContent>{ALIGN_OPTIONS.map((a) => <SelectItem key={a} value={a} className="text-xs">{a}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={c.format ?? "number"} onValueChange={(f) => patchCol(i, { ...c, format: f })}>
                <SelectTrigger className="h-7 text-[10px] px-1"><SelectValue /></SelectTrigger>
                <SelectContent>{VALUE_FORMATS.map((f) => <SelectItem key={f} value={f} className="text-xs">{f}</SelectItem>)}</SelectContent>
              </Select>
              <div className="flex gap-1 items-center">
                <MoveHorizontal className="h-3 w-3 text-muted-foreground" />
                <Input
                  className="h-7 w-16 text-[11px]"
                  value={c.width ?? ""}
                  onChange={(e) => { const v = e.target.value; patchCol(i, { ...c, width: v === "" ? undefined : (/^\d+$/.test(v) ? Number(v) : v) }); }}
                  placeholder="w mm/fr"
                />
                <label className="flex items-center gap-1 text-[10px]">
                  <input type="checkbox" checked={!!c.nowrap} onChange={(e) => patchCol(i, { ...c, nowrap: e.target.checked })} />nowrap
                </label>
                <Input className="h-7 flex-1 text-[11px] font-mono"
                  value={c.bind_key ?? ""} onChange={(e) => patchCol(i, { ...c, bind_key: e.target.value || undefined })}
                  placeholder="bind_key" />
              </div>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" onClick={() => removeCol(i)}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      {/* Header band */}
      <BandPanel
        label="Header rows"
        rowCount={headerRows.length}
        onAddRow={() => addRow("header")}
      >
        {renderBand("header")}
        <BandRowActions band="header" rows={headerRows} onRemoveRow={(i) => removeRow("header", i)} onAddCell={(i) => addCellToRow("header", i)} />
      </BandPanel>

      {/* Data row placeholder */}
      <div className="rounded border bg-muted/20 px-2 py-2">
        <div className="flex items-center gap-2 mb-1">
          <Badge variant="secondary" className="text-[10px]">Data row</Badge>
          <span className="text-[10px] text-muted-foreground">
            Repeats once per item in <code className="font-mono">{dataRows.bind || "(unbound)"}</code>
          </span>
        </div>
        {numCols > 0 && (
          <div className="inline-grid text-[11px] border border-dashed"
            style={{ gridTemplateColumns: colTemplate, minWidth: numCols * 72 }}>
            {cols.map((c, i) => (
              <div key={i} className="px-1.5 py-1 border-r border-border/50 text-muted-foreground font-mono break-all leading-tight"
                style={{ textAlign: c.align ?? "right" }}
                title={`{{${c.bind_key || c.id || `col_${i + 1}`}}}`}>
                {`{{${c.bind_key || c.id || `col_${i + 1}`}}}`}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer band */}
      <BandPanel
        label="Footer rows"
        rowCount={footerRows.length}
        onAddRow={() => addRow("footer")}
      >
        {renderBand("footer")}
        <BandRowActions band="footer" rows={footerRows} onRemoveRow={(i) => removeRow("footer", i)} onAddCell={(i) => addCellToRow("footer", i)} />
      </BandPanel>

      {/* Selected cell inspector */}
      {selection && selectedCell && (
        <div className="rounded border p-2 space-y-2 bg-accent/40">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[11px]">
              <Badge className="text-[10px]" variant="outline">
                {selection.band} · row {selection.rowIdx + 1} · cell {selection.cellIdx + 1}
              </Badge>
              <span className="text-muted-foreground">
                span {selectedCell.span ?? 1} × {selectedCell.row_span ?? 1}
              </span>
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" className="h-7 text-[10px]"
                onClick={() => adjustSpan(selection.band, selection.rowIdx, selection.cellIdx, "span", 1)}
                title="Merge one cell to the right (colspan +1)">
                <ArrowLeftRight className="h-3 w-3 mr-1" />Merge →
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[10px]"
                onClick={() => adjustSpan(selection.band, selection.rowIdx, selection.cellIdx, "span", -1)}
                disabled={(selectedCell.span ?? 1) <= 1}
                title="Split colspan (colspan -1)">
                <RotateCcw className="h-3 w-3 mr-1" />Split →
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[10px]"
                onClick={() => adjustSpan(selection.band, selection.rowIdx, selection.cellIdx, "row_span", 1)}
                title="Merge one row down (rowspan +1)">
                <ArrowUpDown className="h-3 w-3 mr-1" />Merge ↓
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[10px]"
                onClick={() => adjustSpan(selection.band, selection.rowIdx, selection.cellIdx, "row_span", -1)}
                disabled={(selectedCell.row_span ?? 1) <= 1}
                title="Split rowspan (rowspan -1)">
                <RotateCcw className="h-3 w-3 mr-1" />Split ↓
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-destructive w-7 p-0"
                onClick={() => removeCell(selection.band, selection.rowIdx, selection.cellIdx)}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </div>
          <CellContentEditor
            cell={selectedCell}
            allowSumOf={selection.band === "footer"}
            columnIds={columnIds}
            onChange={(next) => patchCell(selection.band, selection.rowIdx, selection.cellIdx, next)}
          />
        </div>
      )}

      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={node.repeat_header !== false}
          onChange={(e) => set({ repeat_header: e.target.checked })} />
        Repeat header row on each page
      </label>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────

function BandPanel({ label, rowCount, onAddRow, children }: {
  label: string; rowCount: number; onAddRow: () => void; children: React.ReactNode;
}) {
  return (
    <div className="rounded border">
      <div className="px-2 py-1 border-b flex items-center justify-between bg-muted/40">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {label} · {rowCount}
        </span>
        <Button type="button" size="sm" variant="outline" className="h-6 text-[10px]" onClick={onAddRow}>
          <Plus className="h-3 w-3 mr-1" />Add row
        </Button>
      </div>
      <div className="p-2 space-y-1">{children}</div>
    </div>
  );
}

function BandRowActions({ band, rows, onRemoveRow, onAddCell }: {
  band: "header" | "footer"; rows: GridRow[];
  onRemoveRow: (i: number) => void; onAddCell: (i: number) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 pt-1 border-t mt-1">
      {rows.map((_, i) => (
        <div key={i} className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-muted/60">
          <span>{band[0]}r{i + 1}</span>
          <button className="hover:text-primary" onClick={() => onAddCell(i)} title="Add cell to this row">
            <Plus className="h-3 w-3" />
          </button>
          <button className="hover:text-destructive" onClick={() => onRemoveRow(i)} title="Remove row">
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

function CellContentEditor({ cell, allowSumOf, columnIds, onChange }: {
  cell: GridCell; allowSumOf: boolean; columnIds: string[];
  onChange: (next: GridCell) => void;
}) {
  const isSum = (cell.content as any)?.kind === "sum_of";
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_100px_100px] gap-2 items-center">
        {isSum ? (
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-[10px]"><Sigma className="h-3 w-3 mr-1" />sum_of</Badge>
            <Select value={(cell.content as any).column_id ?? ""}
              onValueChange={(id) => onChange({ ...cell, content: { kind: "sum_of", column_id: id } })}>
              <SelectTrigger className="h-7 text-[11px]"><SelectValue placeholder="column" /></SelectTrigger>
              <SelectContent>{columnIds.map((id) => <SelectItem key={id} value={id} className="text-xs font-mono">{id}</SelectItem>)}</SelectContent>
            </Select>
            <Button size="sm" variant="ghost" className="h-7 text-[10px]"
              onClick={() => onChange({ ...cell, content: { kind: "literal", value: "" } })}>
              use text
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <ValueEditor value={cell.content as any}
              onChange={(v) => onChange({ ...cell, content: v as Value })}
              placeholder="cell content" />
            {allowSumOf && (
              <Button size="sm" variant="outline" className="h-7 text-[10px]"
                onClick={() => onChange({ ...cell, content: { kind: "sum_of", column_id: columnIds[0] ?? "" } })}
                title="Convert to sum_of (footer total)">
                <Sigma className="h-3 w-3" />
              </Button>
            )}
          </div>
        )}
        <Select value={cell.variant ?? "plain"} onValueChange={(v) => onChange({ ...cell, variant: v as any })}>
          <SelectTrigger className="h-7 text-[10px]"><SelectValue /></SelectTrigger>
          <SelectContent>{CELL_VARIANTS.map((v) => <SelectItem key={v} value={v} className="text-xs">{v}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={cell.align ?? "left"} onValueChange={(a) => onChange({ ...cell, align: a as any })}>
          <SelectTrigger className="h-7 text-[10px]"><SelectValue /></SelectTrigger>
          <SelectContent>{ALIGN_OPTIONS.map((a) => <SelectItem key={a} value={a} className="text-xs">{a}</SelectItem>)}</SelectContent>
        </Select>
      </div>
    </div>
  );
}

function variantClass(v?: string): string {
  switch (v) {
    case "label":  return "font-semibold";
    case "unit":   return "italic text-muted-foreground";
    case "letter": return "font-mono text-[10px] tracking-wide";
    case "note":   return "text-[10px] text-muted-foreground";
    case "total":  return "font-semibold bg-muted/50";
    default:       return "";
  }
}
