/**
 * Client exposure — what each client currently owes the institution across all
 * their active loans, read from the server view `mf_client_exposure`.
 */
import { useCallback, useMemo, useState } from "react";
import { format } from "date-fns";
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
import { useMfClientExposure } from "@/hooks/useMfReports";
import { useBranches } from "@/hooks/useBranches";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import type { ExportConfig } from "@/services/reports/ReportExportService";

const COLUMNS: ReportColumn[] = [
  { key: "client", header: "Client", width: "w-[220px]", sticky: true },
  { key: "branch", header: "Branch", width: "w-[150px]" },
  { key: "officer", header: "Loan officer", width: "w-[160px]" },
  { key: "active_loan_count", header: "Active loans", format: "number", width: "w-[110px]" },
  { key: "principal_outstanding", header: "Principal", format: "currency", width: "w-[140px]" },
  { key: "interest_outstanding", header: "Interest", format: "currency", width: "w-[130px]" },
  { key: "fees_outstanding", header: "Fees", format: "currency", width: "w-[120px]" },
  { key: "total_outstanding", header: "Total exposure", format: "currency", width: "w-[160px]" },
  { key: "amount_overdue", header: "Overdue", format: "currency", width: "w-[140px]" },
  { key: "worst_days_past_due", header: "DPD", format: "number", width: "w-[80px]" },
];

export function ClientExposureReport() {
  const { rows: data, isLoading, error } = useMfClientExposure();
  const { branches } = useBranches();
  const { getUserName } = useOrgMembers();
  const [branch, setBranch] = useState("all");
  const [search, setSearch] = useState("");
  const asOf = format(new Date(), "d MMM yyyy");

  const filtered = useMemo(
    () =>
      data.filter((c) => {
        if (c.active_loan_count === 0) return false;
        if (branch !== "all" && c.branch_id !== branch) return false;
        if (!search.trim()) return true;
        const q = search.trim().toLowerCase();
        return (
          c.full_name.toLowerCase().includes(q) || c.client_number.toLowerCase().includes(q)
        );
      }),
    [data, branch, search],
  );

  const rows = useMemo<ReportRow[]>(() => {
    const detail: ReportRow[] = filtered.map((c) => ({
      id: c.client_id,
      kind: "detail",
      tone: c.worst_days_past_due > 30 ? "danger" : c.amount_overdue > 0 ? "warning" : undefined,
      values: {
        client: `${c.full_name} (${c.client_number})`,
        branch: branches.find((b) => b.id === c.branch_id)?.name ?? "—",
        officer: c.loan_officer_id ? getUserName(c.loan_officer_id) : "Unassigned",
        active_loan_count: c.active_loan_count,
        principal_outstanding: c.principal_outstanding,
        interest_outstanding: c.interest_outstanding,
        fees_outstanding: c.fees_outstanding,
        total_outstanding: c.total_outstanding,
        amount_overdue: c.amount_overdue,
        worst_days_past_due: c.worst_days_past_due,
      },
    }));
    if (detail.length === 0) return detail;
    detail.push({
      id: "total",
      kind: "grandTotal",
      label: "Total exposure",
      values: {
        client: "Total exposure",
        active_loan_count: filtered.reduce((s, c) => s + c.active_loan_count, 0),
        principal_outstanding: filtered.reduce((s, c) => s + c.principal_outstanding, 0),
        interest_outstanding: filtered.reduce((s, c) => s + c.interest_outstanding, 0),
        fees_outstanding: filtered.reduce((s, c) => s + c.fees_outstanding, 0),
        total_outstanding: filtered.reduce((s, c) => s + c.total_outstanding, 0),
        amount_overdue: filtered.reduce((s, c) => s + c.amount_overdue, 0),
      },
    });
    return detail;
  }, [filtered, branches, getUserName]);

  const getExportConfig = useCallback(
    (): ExportConfig => ({
      title: "Client exposure",
      asOf,
      columns: toExportColumns(COLUMNS as ReportColumn<never>[]),
      rows: toExportRows(rows, COLUMNS as ReportColumn<never>[]),
      sheetName: "Exposure",
    }),
    [rows, asOf],
  );

  return (
    <ReportPageLayout
      title="Client exposure"
      description="Outstanding balance and overdue amount per client"
      isLoading={isLoading}
      error={error}
      isEmpty={!isLoading && filtered.length === 0}
      emptyMessage="No clients with active loans match this filter"
      getExportConfig={getExportConfig}
      filters={
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-56 space-y-1.5">
            <Label>Branch</Label>
            <Select value={branch} onValueChange={setBranch}>
              <SelectTrigger>
                <SelectValue placeholder="All branches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-64 space-y-1.5">
            <Label>Search client</Label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name or client number"
            />
          </div>
        </div>
      }
    >
      <ReportSurface title="Client exposure" asOfDate={`As of ${asOf}`}>
        <ReportTable columns={COLUMNS as ReportColumn<never>[]} rows={rows} />
      </ReportSurface>
    </ReportPageLayout>
  );
}

export default ClientExposureReport;
