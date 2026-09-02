/**
 * Loan Portfolio report — outstanding balances per loan, as at today.
 *
 * Rendered by the inherited reporting engine: the page declares columns and
 * typed rows, `ReportPageLayout` owns export, branch scope and institution
 * branding injection. No figure is computed here — every amount comes from
 * the server-derived `mf_loan_balances` view.
 */
import { useCallback, useMemo } from "react";
import { format } from "date-fns";
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
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { useReportWorkspaceState } from "@/hooks/reports/useReportWorkspaceState";
import { useMfPortfolioReport } from "@/hooks/useMfReports";
import { MF_LOAN_STATUS_LABELS, MF_LOAN_STATUSES } from "@/hooks/useMfLoans";
import type { ExportConfig } from "@/services/reports/ReportExportService";

const COLUMNS: ReportColumn[] = [
  { key: "loan_number", header: "Loan", width: "w-[130px]", sticky: true },
  { key: "client", header: "Client", width: "w-[240px]" },
  { key: "status", header: "Status", width: "w-[140px]" },
  { key: "principal", header: "Principal", format: "currency", width: "w-[130px]" },
  { key: "principal_outstanding", header: "Principal o/s", format: "currency", width: "w-[130px]" },
  { key: "interest_outstanding", header: "Interest o/s", format: "currency", width: "w-[130px]" },
  { key: "fees_outstanding", header: "Fees o/s", format: "currency", width: "w-[120px]" },
  { key: "total_outstanding", header: "Total o/s", format: "currency", width: "w-[140px]" },
  { key: "amount_overdue", header: "Overdue", format: "currency", width: "w-[130px]" },
  { key: "days_past_due", header: "DPD", format: "number", width: "w-[80px]" },
  { key: "next_due_date", header: "Next due", format: "date", width: "w-[120px]" },
];

export function PortfolioReport() {
  const workspace = useReportWorkspaceState({ status: "active" });
  const status = workspace.get("status", "active");
  const effectiveStatus = status === "all" ? undefined : status;
  const { rows: data, isLoading, error } = useMfPortfolioReport(effectiveStatus);

  const rows = useMemo<ReportRow[]>(() => {
    const detail: ReportRow[] = data.map((r) => ({
      id: r.loan_id,
      kind: "detail",
      tone: r.days_past_due > 0 ? "danger" : "default",
      values: {
        loan_number: r.loan_number,
        client: r.client_name,
        status: MF_LOAN_STATUS_LABELS[r.status as keyof typeof MF_LOAN_STATUS_LABELS] ?? r.status,
        principal: r.principal,
        principal_outstanding: r.principal_outstanding,
        interest_outstanding: r.interest_outstanding,
        fees_outstanding: r.fees_outstanding,
        total_outstanding: r.total_outstanding,
        amount_overdue: r.amount_overdue,
        days_past_due: r.days_past_due,
        next_due_date: r.next_due_date,
      },
    }));

    if (detail.length === 0) return detail;

    const sum = (pick: (r: (typeof data)[number]) => number) =>
      data.reduce((acc, r) => acc + pick(r), 0);

    detail.push({
      id: "total",
      kind: "grandTotal",
      label: "Portfolio total",
      values: {
        loan_number: "Portfolio total",
        principal: sum((r) => r.principal),
        principal_outstanding: sum((r) => r.principal_outstanding),
        interest_outstanding: sum((r) => r.interest_outstanding),
        fees_outstanding: sum((r) => r.fees_outstanding),
        total_outstanding: sum((r) => r.total_outstanding),
        amount_overdue: sum((r) => r.amount_overdue),
      },
    });
    return detail;
  }, [data]);

  const asOf = format(new Date(), "d MMM yyyy");

  const getExportConfig = useCallback(
    (): ExportConfig => ({
      title: "Loan Portfolio",
      asOf,
      columns: toExportColumns(COLUMNS as ReportColumn<never>[]),
      rows: toExportRows(rows, COLUMNS as ReportColumn<never>[]),
      sheetName: "Portfolio",
    }),
    [rows, asOf],
  );

  return (
    <ReportPageLayout
      title="Loan Portfolio"
      description="Outstanding principal, interest and fees per loan"
      isLoading={isLoading}
      error={error}
      isEmpty={!isLoading && data.length === 0}
      emptyMessage="No loans match the selected status"
      getExportConfig={getExportConfig}
      filters={
        <div className="w-56 space-y-1.5">
          <Label>Loan status</Label>
          <Select value={status} onValueChange={(value) => workspace.set({ status: value })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {MF_LOAN_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {MF_LOAN_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    >
      <ReportSurface title="Loan Portfolio" asOfDate={`As of ${asOf}`}>
        <ReportTable columns={COLUMNS as ReportColumn<never>[]} rows={rows} />
      </ReportSurface>
    </ReportPageLayout>
  );
}

export default PortfolioReport;
