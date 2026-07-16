/**
 * SpreadsheetPreviewPane — enterprise-grade "Excel-like" preview for
 * localization editors whose artefacts are inherently tabular:
 *
 *   - Bank export templates (CSV columns / fixed-width fields)
 *   - Token registry rows
 *   - Garnishment kinds
 *   - Any editor whose payload maps neatly to <header, sample rows>
 *
 * Uses the same live-draft contract as the certificate/return preview
 * panes: the parent editor derives a `columns[] + rows[]` from its
 * current form state and passes them here. Unresolved token bindings
 * surface in red the same way `CertificatePreviewPane` surfaces
 * unresolved bindings — one shared UX contract across the publisher
 * workspace.
 *
 * No new dependencies. Renders as a virtualised (windowed via CSS
 * overflow — small fixtures don't need react-window) monospaced grid so
 * the preview reads like a spreadsheet, with a ruler for fixed-width
 * layouts and a delimiter/encoding status strip below the grid.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, TableIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SpreadsheetPreviewColumn {
  /** Column header shown to the publisher. */
  header: string;
  /** Token binding rendered under the header, e.g. `employee.net_pay`. */
  token?: string | null;
  /** Marks the column's token as unresolved / broken. */
  unresolved?: boolean;
  /** Right-align numeric-looking data. */
  numeric?: boolean;
  /** Fixed-width column length (chars). Enables ruler + monospace grid. */
  width?: number;
  /** Cell format hint shown as a chip. */
  format?: string | null;
}

export interface SpreadsheetPreviewProps {
  title?: string;
  /** e.g. "CSV — columns", "Fixed-width text", "ISO 20022 pain.001". */
  formatLabel?: string;
  columns: SpreadsheetPreviewColumn[];
  /** Row values in column order. Cell can be string | number | null. */
  rows: Array<Array<string | number | null | undefined>>;
  /** Field delimiter for CSV — shown in the status strip. */
  delimiter?: string;
  /** File encoding — shown in the status strip. */
  encoding?: string;
  /** File extension shown in the status strip. */
  fileExtension?: string;
  /** Publisher-facing warnings the editor collected while binding tokens. */
  warnings?: string[];
  /** Fatal errors that block preview (invalid spec, etc). */
  error?: string | null;
  /** For fixed-width — render a ruler above the header row. */
  showRuler?: boolean;
  /** Optional footer note. */
  footnote?: string;
  className?: string;
}

function formatCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v.toLocaleString();
  return String(v);
}

export function SpreadsheetPreviewPane({
  title = "Live preview",
  formatLabel,
  columns,
  rows,
  delimiter,
  encoding,
  fileExtension,
  warnings = [],
  error,
  showRuler,
  footnote,
  className,
}: SpreadsheetPreviewProps) {
  const totalRows = rows.length;
  const unresolvedCount = columns.filter((c) => c.unresolved).length;

  return (
    <Card className={cn("flex h-full min-h-0 w-full flex-col overflow-hidden border-0 shadow-none", className)}>
      <CardHeader className="shrink-0 pb-2 flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <TableIcon className="h-4 w-4" /> {title}
          {formatLabel && (
            <Badge variant="outline" className="text-[10px]">{formatLabel}</Badge>
          )}
        </CardTitle>
        <div className="flex items-center gap-2">
          {unresolvedCount > 0 && (
            <Badge variant="destructive" className="text-[10px]">
              {unresolvedCount} unresolved token{unresolvedCount > 1 ? "s" : ""}
            </Badge>
          )}
          {warnings.length > 0 && (
            <Badge variant="outline" className="text-[10px] border-amber-500 text-amber-700 dark:text-amber-400">
              {warnings.length} warning{warnings.length > 1 ? "s" : ""}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        {error ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="break-all text-xs">{error}</AlertDescription>
          </Alert>
        ) : columns.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded border border-dashed bg-muted/20 p-6 text-center text-xs text-muted-foreground">
            No columns configured yet — bind at least one token in the editor
            to see how the exported file will look.
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto rounded border bg-background">
            <table className="w-full border-collapse font-mono text-[11px]">
              <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur">
                {showRuler && (
                  <tr className="border-b text-[9px] text-muted-foreground/70">
                    {columns.map((c, i) => (
                      <th
                        key={`ruler-${i}`}
                        className="border-r px-2 py-0.5 text-left last:border-r-0"
                      >
                        {c.width ? `${c.width}ch` : ""}
                      </th>
                    ))}
                  </tr>
                )}
                <tr className="border-b">
                  {columns.map((c, i) => (
                    <th
                      key={`h-${i}`}
                      className={cn(
                        "border-r px-2 py-1 text-left align-top font-semibold last:border-r-0",
                        c.numeric && "text-right",
                        c.unresolved && "bg-destructive/10 text-destructive",
                      )}
                      style={c.width ? { minWidth: `${c.width}ch` } : undefined}
                    >
                      <div className="flex items-center gap-1">
                        <span>{c.header || <em className="text-muted-foreground">(unnamed)</em>}</span>
                        {c.format && (
                          <span className="rounded bg-muted px-1 py-0 text-[9px] text-muted-foreground">
                            {c.format}
                          </span>
                        )}
                      </div>
                      {c.token && (
                        <div className={cn(
                          "text-[9px] font-normal text-muted-foreground",
                          c.unresolved && "text-destructive",
                        )}>
                          {c.token}
                        </div>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={columns.length} className="px-3 py-6 text-center text-xs text-muted-foreground">
                      No sample rows.
                    </td>
                  </tr>
                )}
                {rows.map((row, ri) => (
                  <tr key={`r-${ri}`} className="border-b last:border-b-0 odd:bg-muted/10">
                    {columns.map((c, ci) => (
                      <td
                        key={`c-${ri}-${ci}`}
                        className={cn(
                          "border-r px-2 py-0.5 tabular-nums last:border-r-0",
                          c.numeric && "text-right",
                          c.unresolved && "text-destructive/70",
                        )}
                      >
                        {formatCell(row[ci])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {warnings.length > 0 && (
          <div className="max-h-24 shrink-0 overflow-auto rounded border border-amber-300/60 bg-amber-50/40 p-2 text-[10px] text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
            <ul className="list-disc pl-4 space-y-0.5">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}

        <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          <span>{totalRows} sample row{totalRows === 1 ? "" : "s"}</span>
          <span>{columns.length} column{columns.length === 1 ? "" : "s"}</span>
          {delimiter && <span>delim: <code className="rounded bg-muted px-1">{delimiter === "\t" ? "\\t" : delimiter}</code></span>}
          {encoding && <span>encoding: <code className="rounded bg-muted px-1">{encoding}</code></span>}
          {fileExtension && <span>ext: <code className="rounded bg-muted px-1">.{fileExtension}</code></span>}
          {footnote && <span className="ml-auto italic">{footnote}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

export default SpreadsheetPreviewPane;