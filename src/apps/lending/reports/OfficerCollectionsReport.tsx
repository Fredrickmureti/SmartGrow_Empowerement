/**
 * Officer & branch collections — cash actually received in a period, grouped
 * by loan officer or by branch. Amounts come from the server views
 * `mf_collections_by_officer` / `mf_collections_by_branch`, which read posted
 * receipts only; reversals never appear.
 */
import { useCallback, useMemo } from "react";
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
import { useMfCollectionsByScope } from "@/hooks/useMfReports";
import { useBranches } from "@/hooks/useBranches";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import type { ExportConfig } from "@/services/reports/ReportExportService";

const COLUMNS: ReportColumn[] = [
  { key: "scope", header: "Collected by", width: "w-[220px]", sticky: true },
  { key: "client_count", header: "Clients", format: "number", width: "w-[100px]" },
  { key: "receipt_count", header: "Receipts", format: "number", width: "w-[100px]" },
  { key: "cash_collected", header: "Cash", format: "currency", width: "w-[140px]" },
  { key: "mobile_money_collected", header: "Mobile money", format: "currency", width: "w-[150px]" },
  { key: "other_collected", header: "Other", format: "currency", width: "w-[130px]" },
  { key: "amount_collected", header: "Total collected", format: "currency", width: "w-[160px]" },
];

export function OfficerCollectionsReport() {
  const today = format(new Date(), "yyyy-MM-dd");
  const monthStart = format(startOfMonth(new Date()), "yyyy-MM-dd");
  const workspace = useReportWorkspaceState({ group: "officer", from: monthStart, to: today });
  const scope = (workspace.get("group", "officer") === "branch" ? "branch" : "officer") as
    | "officer"
    | "branch";
  const from = workspace.get("from", monthStart);
  const to = workspace.get("to", today);

  const { rows: data, isLoading, error } = useMfCollectionsByScope(scope, from, to);
  const { branches } = useBranches();
  const { getUserName } = useOrgMembers();

  const label = useCallback(
    (row: { branch_id: string | null; loan_officer_id: string | null }) => {
      if (scope === "branch") {
        return branches.find((b) => b.id === row.branch_id)?.name ?? "Unassigned branch";
      }
      return row.loan_officer_id ? getUserName(row.loan_officer_id) : "Unassigned officer";
    },
    [scope, branches, getUserName],
  );

  const grouped = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        scope: string;
        client_count: number;
        receipt_count: number;
        cash_collected: number;
        mobile_money_collected: number;
        other_collected: number;
        amount_collected: number;
      }
    >();
    for (const row of data) {
      const key = (scope === "branch" ? row.branch_id : row.loan_officer_id) ?? "unassigned";
      const entry =
        map.get(key) ??
        {
          key,
          scope: label(row),
          client_count: 0,
          receipt_count: 0,
          cash_collected: 0,
          mobile_money_collected: 0,
          other_collected: 0,
          amount_collected: 0,
        };
      entry.client_count += row.client_count;
      entry.receipt_count += row.receipt_count;
      entry.cash_collected += row.cash_collected;
      entry.mobile_money_collected += row.mobile_money_collected;
      entry.other_collected += row.other_collected;
      entry.amount_collected += row.amount_collected;
      map.set(key, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.amount_collected - a.amount_collected);
  }, [data, scope, label]);

  const rows = useMemo<ReportRow[]>(() => {
    const detail: ReportRow[] = grouped.map((g) => ({
      id: g.key,
      kind: "detail",
      values: {
        scope: g.scope,
        client_count: g.client_count,
        receipt_count: g.receipt_count,
        cash_collected: g.cash_collected,
        mobile_money_collected: g.mobile_money_collected,
        other_collected: g.other_collected,
        amount_collected: g.amount_collected,
      },
    }));
    if (detail.length === 0) return detail;
    detail.push({
      id: "total",
      kind: "grandTotal",
      label: "Total collected",
      values: {
        scope: "Total collected",
        client_count: grouped.reduce((s, g) => s + g.client_count, 0),
        receipt_count: grouped.reduce((s, g) => s + g.receipt_count, 0),
        cash_collected: grouped.reduce((s, g) => s + g.cash_collected, 0),
        mobile_money_collected: grouped.reduce((s, g) => s + g.mobile_money_collected, 0),
        other_collected: grouped.reduce((s, g) => s + g.other_collected, 0),
        amount_collected: grouped.reduce((s, g) => s + g.amount_collected, 0),
      },
    });
    return detail;
  }, [grouped]);

  const getExportConfig = useCallback(
    (): ExportConfig => ({
      title: scope === "branch" ? "Branch collections" : "Officer collections",
      dateRange: `${from} to ${to}`,
      columns: toExportColumns(COLUMNS as ReportColumn<never>[]),
      rows: toExportRows(rows, COLUMNS as ReportColumn<never>[]),
      sheetName: "Collections",
    }),
    [rows, scope, from, to],
  );

  return (
    <ReportPageLayout
      title={scope === "branch" ? "Branch collections" : "Officer collections"}
      description="Posted receipts for the period, grouped by who collected them"
      isLoading={isLoading}
      error={error}
      isEmpty={!isLoading && grouped.length === 0}
      emptyMessage="No collections in the selected period"
      getExportConfig={getExportConfig}
      filters={
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-48 space-y-1.5">
            <Label>Group by</Label>
            <Select value={scope} onValueChange={(value) => workspace.set({ group: value })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="officer">Loan officer</SelectItem>
                <SelectItem value="branch">Branch</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="w-40 space-y-1.5">
            <Label>From</Label>
            <Input
              type="date"
              value={from}
              onChange={(e) => workspace.set({ from: e.target.value })}
            />
          </div>
          <div className="w-40 space-y-1.5">
            <Label>To</Label>
            <Input type="date" value={to} onChange={(e) => workspace.set({ to: e.target.value })} />
          </div>
        </div>
      }
    >
      <ReportSurface
        title={scope === "branch" ? "Branch collections" : "Officer collections"}
        asOfDate={`${format(new Date(from), "d MMM yyyy")} – ${format(new Date(to), "d MMM yyyy")}`}
      >
        <ReportTable columns={COLUMNS as ReportColumn<never>[]} rows={rows} />
      </ReportSurface>
    </ReportPageLayout>
  );
}

export default OfficerCollectionsReport;
