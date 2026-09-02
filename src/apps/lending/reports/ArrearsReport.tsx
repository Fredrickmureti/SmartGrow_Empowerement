/**
 * Arrears, aging and PAR — read from the server-derived `mf_loan_arrears`
 * and `mf_par_summary` views. Days past due, arrears amounts and PAR ratios
 * are never computed in the browser.
 */
import { useCallback, useMemo } from "react";
import { format } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import {
  ReportSurface,
  ReportTable,
  formatAccountingNumber,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { useReportWorkspaceState } from "@/hooks/reports/useReportWorkspaceState";
import { useMfArrears, useMfParSummary } from "@/hooks/useMfCollections";
import type { ExportConfig } from "@/services/reports/ReportExportService";

const COLUMNS: ReportColumn[] = [
  { key: "loan_number", header: "Loan", width: "w-[130px]", sticky: true },
  { key: "installment_no", header: "Inst.", format: "number", width: "w-[80px]" },
  { key: "due_date", header: "Due date", format: "date", width: "w-[120px]" },
  { key: "bucket", header: "Aging bucket", width: "w-[130px]" },
  { key: "days_past_due", header: "DPD", format: "number", width: "w-[80px]" },
  { key: "principal_due", header: "Principal due", format: "currency", width: "w-[130px]" },
  { key: "interest_due", header: "Interest due", format: "currency", width: "w-[130px]" },
  { key: "fees_due", header: "Fees due", format: "currency", width: "w-[120px]" },
  { key: "total_paid", header: "Paid", format: "currency", width: "w-[120px]" },
  { key: "arrears_amount", header: "Arrears", format: "currency", width: "w-[140px]" },
];

const BUCKETS: Array<{ key: string; label: string; min: number; max: number }> = [
  { key: "1-30", label: "1–30 days", min: 1, max: 30 },
  { key: "31-60", label: "31–60 days", min: 31, max: 60 },
  { key: "61-90", label: "61–90 days", min: 61, max: 90 },
  { key: "90+", label: "Over 90 days", min: 91, max: Number.MAX_SAFE_INTEGER },
];

function bucketOf(dpd: number) {
  return BUCKETS.find((b) => dpd >= b.min && dpd <= b.max)?.label ?? "Current";
}

export function ArrearsReport() {
  const workspace = useReportWorkspaceState({ group: "all" });
  const bucket = workspace.get("group", "all");
  const { arrears, isLoading, error } = useMfArrears();
  const { par } = useMfParSummary();

  const filtered = useMemo(
    () =>
      bucket === "all"
        ? arrears
        : arrears.filter((a) => bucketOf(Number(a.days_past_due)) === bucket),
    [arrears, bucket],
  );

  const rows = useMemo<ReportRow[]>(() => {
    const detail: ReportRow[] = filtered.map((a) => ({
      id: `${a.loan_id}-${a.installment_no}`,
      kind: "detail",
      tone: Number(a.days_past_due) > 30 ? "danger" : "warning",
      values: {
        loan_number: a.loan_number,
        installment_no: a.installment_no,
        due_date: a.due_date,
        bucket: bucketOf(Number(a.days_past_due)),
        days_past_due: a.days_past_due,
        principal_due: Number(a.principal_due),
        interest_due: Number(a.interest_due),
        fees_due: Number(a.fees_due),
        total_paid: Number(a.total_paid),
        arrears_amount: Number(a.arrears_amount),
      },
    }));

    if (detail.length === 0) return detail;
    detail.push({
      id: "total",
      kind: "grandTotal",
      label: "Total arrears",
      values: {
        loan_number: "Total arrears",
        principal_due: filtered.reduce((s, a) => s + Number(a.principal_due), 0),
        interest_due: filtered.reduce((s, a) => s + Number(a.interest_due), 0),
        fees_due: filtered.reduce((s, a) => s + Number(a.fees_due), 0),
        total_paid: filtered.reduce((s, a) => s + Number(a.total_paid), 0),
        arrears_amount: filtered.reduce((s, a) => s + Number(a.arrears_amount), 0),
      },
    });
    return detail;
  }, [filtered]);

  const portfolio = par.reduce((s, p) => s + Number(p.portfolio_outstanding ?? 0), 0);
  const parAt = (key: "par_1" | "par_30" | "par_90") =>
    par.reduce((s, p) => s + Number(p[key] ?? 0), 0);
  const ratio = (value: number) => (portfolio > 0 ? (value / portfolio) * 100 : 0);

  const asOf = format(new Date(), "d MMM yyyy");

  const getExportConfig = useCallback(
    (): ExportConfig => ({
      title: "Arrears & PAR",
      asOf,
      columns: toExportColumns(COLUMNS as ReportColumn<never>[]),
      rows: toExportRows(rows, COLUMNS as ReportColumn<never>[]),
      sheetName: "Arrears",
    }),
    [rows, asOf],
  );

  return (
    <ReportPageLayout
      title="Arrears & PAR"
      description="Overdue installments, aging buckets and portfolio at risk"
      isLoading={isLoading}
      error={error}
      isEmpty={!isLoading && filtered.length === 0}
      emptyMessage="No overdue installments for the selected bucket"
      getExportConfig={getExportConfig}
      filters={
        <div className="w-56 space-y-1.5">
          <Label>Aging bucket</Label>
          <Select value={bucket} onValueChange={(value) => workspace.set({ group: value })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All buckets</SelectItem>
              {BUCKETS.map((b) => (
                <SelectItem key={b.key} value={b.label}>
                  {b.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    >
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: "Portfolio outstanding", value: formatAccountingNumber(portfolio) },
            { label: "PAR 1+", value: `${ratio(parAt("par_1")).toFixed(2)}%` },
            { label: "PAR 30+", value: `${ratio(parAt("par_30")).toFixed(2)}%` },
            { label: "PAR 90+", value: `${ratio(parAt("par_90")).toFixed(2)}%` },
          ].map((kpi) => (
            <Card key={kpi.label}>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">{kpi.label}</p>
                <p className="text-2xl font-semibold tabular-nums">{kpi.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <ReportSurface title="Arrears & PAR" asOfDate={`As of ${asOf}`}>
          <ReportTable columns={COLUMNS as ReportColumn<never>[]} rows={rows} />
        </ReportSurface>
      </div>
    </ReportPageLayout>
  );
}

export default ArrearsReport;
