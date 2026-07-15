/**
 * PayrollReportKpiBand — 3-4 metric cards computed from the rows the
 * viewer already fetched. Definitions may declare a `metadata.kpis`
 * array to opt into bespoke KPIs; when absent, we fall back to a
 * generic set (row count + sum of the first 1-3 money columns) so
 * every existing report gets a professional header without a DB
 * migration.
 *
 * KpiSpec shape (on payroll_report_definitions.metadata.kpis):
 *   { key: string; label: string;
 *     agg: "sum" | "avg" | "count" | "min" | "max";
 *     format?: "currency" | "number" | "percent" }
 */
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useCurrency } from "@/hooks/useCurrency";
import type { PayrollReportDefinition } from "@/hooks/payroll/usePayrollReportDefinitions";

interface Column {
  key: string;
  header: string;
  format?: string;
  align?: string;
}

interface KpiSpec {
  key: string;
  label: string;
  agg: "sum" | "avg" | "count" | "min" | "max";
  format?: "currency" | "number" | "percent";
}

interface Props {
  definition: PayrollReportDefinition;
  columns: Column[];
  rows: any[];
  canSeeMoney: boolean;
}

const isMoneyCol = (col: Column) =>
  col.format === "currency" || /amount|total|gross|net|pay|cost/i.test(col.key);

function aggregate(rows: any[], key: string, agg: KpiSpec["agg"]): number {
  const nums = rows
    .map((r) => Number(r?.[key]))
    .filter((n) => Number.isFinite(n));
  if (nums.length === 0) return 0;
  switch (agg) {
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "count":
      return nums.length;
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
  }
}

function inferKpis(columns: Column[]): KpiSpec[] {
  // Skip any totals row keys — those are already precomputed. Pick up
  // to 3 money columns and sum them. Row count is always the first KPI
  // so users never see a bare page again.
  const moneyCols = columns.filter(isMoneyCol).slice(0, 3);
  return moneyCols.map((c) => ({
    key: c.key,
    label: `Total ${c.header}`,
    agg: "sum" as const,
    format: "currency" as const,
  }));
}

export function PayrollReportKpiBand({
  definition,
  columns,
  rows,
  canSeeMoney,
}: Props) {
  const { formatCurrency } = useCurrency();
  const meta = definition.metadata as Record<string, unknown>;
  const declared = Array.isArray(meta?.kpis) ? (meta.kpis as KpiSpec[]) : null;
  const kpis = declared && declared.length > 0 ? declared : inferKpis(columns);

  // Totals row (some reports append a synthetic totals row); when we
  // detect one, prefer its precomputed value over re-summing to avoid
  // double-counting subtotals.
  const totalsRow =
    rows.length > 0 && (rows[rows.length - 1] as any)?._isGrandTotal
      ? rows[rows.length - 1]
      : null;
  const dataRows = totalsRow ? rows.slice(0, -1) : rows;

  const fmt = (v: number, format?: KpiSpec["format"]) => {
    if (format === "currency") return formatCurrency(v);
    if (format === "percent") return `${(v * 100).toFixed(1)}%`;
    return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };

  const cards: { label: string; value: React.ReactNode; hidden?: boolean }[] = [
    {
      label: "Rows",
      value: dataRows.length.toLocaleString(),
    },
    ...kpis.slice(0, 3).map((k) => {
      const raw = totalsRow?.[k.key];
      const v =
        raw != null && Number.isFinite(Number(raw))
          ? Number(raw)
          : aggregate(dataRows, k.key, k.agg);
      const money = k.format === "currency";
      return {
        label: k.label,
        value:
          money && !canSeeMoney ? (
            <Badge variant="secondary" className="font-normal">
              Hidden
            </Badge>
          ) : (
            fmt(v, k.format)
          ),
      };
    }),
  ];

  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="pt-4">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {c.label}
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {c.value}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default PayrollReportKpiBand;
