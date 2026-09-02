/**
 * Disbursements report — loans disbursed in a period.
 *
 * Rows are the append-only `mf_loan_disbursements` events; reversed
 * disbursements are listed but excluded from the net disbursed total.
 */
import { useCallback, useMemo } from "react";
import { format, startOfMonth } from "date-fns";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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
import { useMfDisbursementsReport } from "@/hooks/useMfReports";
import type { ExportConfig } from "@/services/reports/ReportExportService";

const COLUMNS: ReportColumn[] = [
  { key: "disbursed_on", header: "Date", format: "date", width: "w-[120px]", sticky: true },
  { key: "loan_number", header: "Loan", width: "w-[130px]" },
  { key: "method", header: "Method", width: "w-[130px]" },
  { key: "reference", header: "Reference", width: "w-[160px]" },
  { key: "received_by", header: "Received by", width: "w-[200px]" },
  { key: "status", header: "Status", width: "w-[120px]" },
  { key: "amount", header: "Amount", format: "currency", width: "w-[140px]" },
];

export function DisbursementsReport() {
  const today = format(new Date(), "yyyy-MM-dd");
  const monthStart = format(startOfMonth(new Date()), "yyyy-MM-dd");
  const workspace = useReportWorkspaceState({ from: monthStart, to: today });
  const from = workspace.get("from", monthStart);
  const to = workspace.get("to", today);

  const { rows: data, isLoading, error } = useMfDisbursementsReport(from, to);

  const rows = useMemo<ReportRow[]>(() => {
    const detail: ReportRow[] = data.map((r) => ({
      id: r.id,
      kind: "detail",
      tone: r.reversed ? "muted" : "default",
      values: {
        disbursed_on: r.disbursed_on,
        loan_number: r.loan_number,
        method: r.method,
        reference: r.reference ?? "—",
        received_by: r.received_by_name ?? "—",
        status: r.reversed ? "Reversed" : "Posted",
        amount: r.amount,
      },
    }));

    if (detail.length === 0) return detail;

    detail.push({
      id: "total",
      kind: "grandTotal",
      label: "Net disbursed",
      values: {
        disbursed_on: "Net disbursed",
        amount: data
          .filter((r) => !r.reversed)
          .reduce((acc, r) => acc + r.amount, 0),
      },
    });
    return detail;
  }, [data]);

  const getExportConfig = useCallback(
    (): ExportConfig => ({
      title: "Disbursements",
      asOf: `${from} to ${to}`,
      columns: toExportColumns(COLUMNS as ReportColumn<never>[]),
      rows: toExportRows(rows, COLUMNS as ReportColumn<never>[]),
      sheetName: "Disbursements",
    }),
    [rows, from, to],
  );

  return (
    <ReportPageLayout
      title="Disbursements"
      description="Loans disbursed in the selected period"
      isLoading={isLoading}
      error={error}
      isEmpty={!isLoading && data.length === 0}
      emptyMessage="No disbursements in this period"
      getExportConfig={getExportConfig}
      filters={
        <div className="flex flex-wrap gap-4">
          <div className="w-44 space-y-1.5">
            <Label>From</Label>
            <Input
              type="date"
              value={from}
              onChange={(e) => workspace.set({ from: e.target.value })}
            />
          </div>
          <div className="w-44 space-y-1.5">
            <Label>To</Label>
            <Input
              type="date"
              value={to}
              onChange={(e) => workspace.set({ to: e.target.value })}
            />
          </div>
        </div>
      }
    >
      <ReportSurface title="Disbursements" asOfDate={`${from} — ${to}`}>
        <ReportTable columns={COLUMNS as ReportColumn<never>[]} rows={rows} />
      </ReportSurface>
    </ReportPageLayout>
  );
}

export default DisbursementsReport;
