/**
 * Collections report — repayments received in a period.
 *
 * Amounts come straight off the append-only `mf_repayments` rows; the browser
 * only totals what the server already recorded, and reversed receipts are
 * shown but excluded from the collected total.
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
import { useMfCollectionsReport } from "@/hooks/useMfReports";
import type { ExportConfig } from "@/services/reports/ReportExportService";

const COLUMNS: ReportColumn[] = [
  { key: "paid_on", header: "Date", format: "date", width: "w-[120px]", sticky: true },
  { key: "receipt_number", header: "Receipt", width: "w-[140px]" },
  { key: "loan_number", header: "Loan", width: "w-[130px]" },
  { key: "client", header: "Client", width: "w-[240px]" },
  { key: "method", header: "Method", width: "w-[130px]" },
  { key: "reference", header: "Reference", width: "w-[160px]" },
  { key: "status", header: "Status", width: "w-[120px]" },
  { key: "amount", header: "Amount", format: "currency", width: "w-[140px]" },
];

export function CollectionsReport() {
  const today = format(new Date(), "yyyy-MM-dd");
  const monthStart = format(startOfMonth(new Date()), "yyyy-MM-dd");
  const workspace = useReportWorkspaceState({ from: monthStart, to: today });
  const from = workspace.get("from", monthStart);
  const to = workspace.get("to", today);

  const { rows: data, isLoading, error } = useMfCollectionsReport(from, to);

  const rows = useMemo<ReportRow[]>(() => {
    const detail: ReportRow[] = data.map((r) => ({
      id: r.id,
      kind: "detail",
      tone: r.status === "reversed" ? "warning" : "default",
      values: {
        paid_on: r.paid_on,
        receipt_number: r.receipt_number ?? "—",
        loan_number: r.loan_number,
        client: r.client_name,
        method: r.method,
        reference: r.reference ?? "—",
        status: r.status,
        amount: r.amount,
      },
    }));

    if (detail.length === 0) return detail;

    detail.push({
      id: "total",
      kind: "grandTotal",
      label: "Total collected",
      values: {
        paid_on: "Total collected",
        amount: data
          .filter((r) => r.status !== "reversed")
          .reduce((acc, r) => acc + r.amount, 0),
      },
    });
    return detail;
  }, [data]);

  const getExportConfig = useCallback(
    (): ExportConfig => ({
      title: "Collections",
      asOf: `${from} to ${to}`,
      columns: toExportColumns(COLUMNS as ReportColumn<never>[]),
      rows: toExportRows(rows, COLUMNS as ReportColumn<never>[]),
      sheetName: "Collections",
    }),
    [rows, from, to],
  );

  return (
    <ReportPageLayout
      title="Collections"
      description="Repayments received in the selected period"
      isLoading={isLoading}
      error={error}
      isEmpty={!isLoading && data.length === 0}
      emptyMessage="No repayments recorded in this period"
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
      <ReportSurface title="Collections" asOfDate={`${from} — ${to}`}>
        <ReportTable columns={COLUMNS as ReportColumn<never>[]} rows={rows} />
      </ReportSurface>
    </ReportPageLayout>
  );
}

export default CollectionsReport;
