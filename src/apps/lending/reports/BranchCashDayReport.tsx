/**
 * Daily branch cash report — one row per operational day.
 *
 * Opening cash, cash received, cash paid out and the cash the books expect are
 * all derived server-side from the posted ledger; the counted cash and the
 * over/short are the figures recorded when the day was closed. No totals are
 * recalculated here, so this report and the general ledger cannot diverge.
 */
import { useCallback, useMemo, useState } from "react";
import { format, startOfMonth } from "date-fns";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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
import { useBranches } from "@/hooks/useBranches";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import { useBranchDayCashReport } from "@/hooks/useBranchDayCashReport";
import type { ExportConfig } from "@/services/reports/ReportExportService";

const COLUMNS: ReportColumn[] = [
  { key: "business_date", header: "Day", format: "date", width: "w-[120px]", sticky: true },
  { key: "status", header: "Status", width: "w-[100px]" },
  { key: "opening_cash", header: "Opening", format: "currency", width: "w-[130px]" },
  { key: "cash_in", header: "Cash in", format: "currency", width: "w-[130px]" },
  { key: "cash_out", header: "Cash out", format: "currency", width: "w-[130px]" },
  { key: "expected_cash", header: "Books expect", format: "currency", width: "w-[140px]" },
  { key: "counted_cash", header: "Counted", format: "currency", width: "w-[130px]" },
  { key: "variance", header: "Over / short", format: "currency", width: "w-[130px]" },
  { key: "closed_by", header: "Closed by", width: "w-[180px]" },
];

export function BranchCashDayReport() {
  const today = format(new Date(), "yyyy-MM-dd");
  const monthStart = format(startOfMonth(new Date()), "yyyy-MM-dd");
  const workspace = useReportWorkspaceState({ from: monthStart, to: today });
  const from = workspace.get("from", monthStart);
  const to = workspace.get("to", today);

  const { branches, currentBranch } = useBranches();
  const { getUserName } = useOrgMembers();
  const [branchId, setBranchId] = useState<string>(
    () => currentBranch?.id ?? branches[0]?.id ?? "",
  );

  const { rows: data, isLoading, error } = useBranchDayCashReport(
    branchId || null,
    from,
    to,
  );

  const rows = useMemo<ReportRow[]>(() => {
    const detail: ReportRow[] = data.map((r) => ({
      id: r.day_id,
      kind: "detail",
      tone:
        r.variance != null && Number(r.variance) !== 0
          ? "warning"
          : r.status === "open"
            ? "info"
            : "default",
      values: {
        business_date: r.business_date,
        status: r.status === "open" ? "Open" : "Closed",
        opening_cash: r.opening_cash,
        cash_in: r.cash_in,
        cash_out: r.cash_out,
        expected_cash: r.expected_cash,
        counted_cash: r.counted_cash ?? "—",
        variance: r.variance ?? "—",
        closed_by: r.closed_by ? getUserName(r.closed_by) : "—",
      },
    }));

    if (detail.length === 0) return detail;

    detail.push({
      id: "total",
      kind: "grandTotal",
      label: "Period total",
      values: {
        business_date: "Period total",
        cash_in: data.reduce((acc, r) => acc + r.cash_in, 0),
        cash_out: data.reduce((acc, r) => acc + r.cash_out, 0),
        variance: data.reduce((acc, r) => acc + Number(r.variance ?? 0), 0),
      },
    });
    return detail;
  }, [data, getUserName]);

  const getExportConfig = useCallback(
    (): ExportConfig => ({
      title: "Daily branch cash",
      asOf: `${from} to ${to}`,
      columns: toExportColumns(COLUMNS as ReportColumn<never>[]),
      rows: toExportRows(rows, COLUMNS as ReportColumn<never>[]),
      sheetName: "Daily cash",
    }),
    [rows, from, to],
  );

  return (
    <ReportPageLayout
      title="Daily branch cash"
      description="Each operational day with its opening cash, movements, count and over/short"
      isLoading={isLoading}
      error={error}
      isEmpty={!isLoading && data.length === 0}
      emptyMessage="No operational days recorded for this branch in this period"
      getExportConfig={getExportConfig}
      filters={
        <div className="flex flex-wrap gap-4">
          <div className="w-56 space-y-1.5">
            <Label>Branch</Label>
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a branch" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
      <ReportSurface title="Daily branch cash" asOfDate={`${from} — ${to}`}>
        <ReportTable columns={COLUMNS as ReportColumn<never>[]} rows={rows} />
      </ReportSurface>
    </ReportPageLayout>
  );
}

export default BranchCashDayReport;
