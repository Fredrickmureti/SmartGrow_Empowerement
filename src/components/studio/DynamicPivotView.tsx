import { useMemo } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SavedView } from "@/hooks/useSavedViews";
import { Loader2 } from "lucide-react";

interface PivotConfig {
  row_field: string;
  column_field?: string;
  value_field: string;
  aggregation: "sum" | "count" | "avg" | "min" | "max";
}

interface DynamicPivotViewProps<T extends Record<string, unknown>> {
  view: SavedView;
  data: T[];
  isLoading?: boolean;
  formatValue?: (value: number) => string;
}

function aggregate(values: number[], method: string): number {
  if (values.length === 0) return 0;
  switch (method) {
    case "sum": return values.reduce((a, b) => a + b, 0);
    case "count": return values.length;
    case "avg": return values.reduce((a, b) => a + b, 0) / values.length;
    case "min": return Math.min(...values);
    case "max": return Math.max(...values);
    default: return values.reduce((a, b) => a + b, 0);
  }
}

export function DynamicPivotView<T extends Record<string, unknown>>({
  view,
  data,
  isLoading,
  formatValue = (v) => v.toLocaleString(),
}: DynamicPivotViewProps<T>) {
  const config = view.view_config as unknown as PivotConfig;

  const pivotData = useMemo(() => {
    if (!config?.row_field || !config?.value_field) {
      return { rows: [], columns: [], matrix: {} as Record<string, Record<string, number>>, rowTotals: {} as Record<string, number>, columnTotals: {} as Record<string, number>, grandTotal: 0 };
    }

    const rows = new Set<string>();
    const columns = new Set<string>();
    const matrix: Record<string, Record<string, number[]>> = {};

    data.forEach((item) => {
      const rowKey = String(item[config.row_field] ?? "Other");
      const colKey = config.column_field ? String(item[config.column_field] ?? "Other") : "Value";
      const value = Number(item[config.value_field]) || 0;
      rows.add(rowKey);
      columns.add(colKey);
      if (!matrix[rowKey]) matrix[rowKey] = {};
      if (!matrix[rowKey][colKey]) matrix[rowKey][colKey] = [];
      matrix[rowKey][colKey].push(value);
    });

    const aggregatedMatrix: Record<string, Record<string, number>> = {};
    const rowTotals: Record<string, number> = {};
    const columnTotals: Record<string, number> = {};
    const rowKeys = Array.from(rows).sort();
    const colKeys = Array.from(columns).sort();

    rowKeys.forEach((row) => {
      aggregatedMatrix[row] = {};
      let rowTotal = 0;
      colKeys.forEach((col) => {
        const values = matrix[row]?.[col] || [];
        const agg = aggregate(values, config.aggregation || "sum");
        aggregatedMatrix[row][col] = agg;
        rowTotal += agg;
        columnTotals[col] = (columnTotals[col] || 0) + agg;
      });
      rowTotals[row] = rowTotal;
    });

    return { rows: rowKeys, columns: colKeys, matrix: aggregatedMatrix, rowTotals, columnTotals, grandTotal: Object.values(rowTotals).reduce((a, b) => a + b, 0) };
  }, [data, config]);

  if (isLoading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  if (!config?.row_field) {
    return <Card><CardContent className="py-8 text-center text-muted-foreground">Configure row and value fields</CardContent></Card>;
  }

  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-sm">{view.view_name}</CardTitle></CardHeader>
      <CardContent>
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="font-bold bg-muted">{config.row_field}</TableHead>
                {pivotData.columns.map((col) => <TableHead key={col} className="text-right bg-muted">{col}</TableHead>)}
                <TableHead className="text-right font-bold bg-muted">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pivotData.rows.map((row) => (
                <TableRow key={row}>
                  <TableCell className="font-medium">{row}</TableCell>
                  {pivotData.columns.map((col) => <TableCell key={col} className="text-right">{formatValue(pivotData.matrix[row]?.[col] ?? 0)}</TableCell>)}
                  <TableCell className="text-right font-medium">{formatValue(pivotData.rowTotals[row] ?? 0)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
