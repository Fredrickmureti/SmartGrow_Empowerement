/**
 * PAR aging — portfolio outstanding split into days-past-due buckets per
 * branch or per loan officer. Every amount comes from the server view
 * `mf_par_aging`; the browser only groups and formats.
 */
import { useCallback, useMemo, useState } from "react";
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
import { useMfParAging } from "@/hooks/useMfReports";
import { useBranches } from "@/hooks/useBranches";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import type { ExportConfig } from "@/services/reports/ReportExportService";

const COLUMNS: ReportColumn[] = [
  { key: "scope", header: "Scope", width: "w-[200px]", sticky: true },
  { key: "loan_count", header: "Loans", format: "number", width: "w-[90px]" },
  { key: "loans_in_arrears", header: "In arrears", format: "number", width: "w-[110px]" },
  { key: "portfolio_outstanding", header: "Portfolio", format: "currency", width: "w-[150px]" },
  { key: "current_outstanding", header: "Current", format: "currency", width: "w-[140px]" },
  { key: "bucket_1_30", header: "1–30 days", format: "currency", width: "w-[130px]" },
  { key: "bucket_31_60", header: "31–60 days", format: "currency", width: "w-[130px]" },
  { key: "bucket_61_90", header: "61–90 days", format: "currency", width: "w-[130px]" },
  { key: "bucket_90_plus", header: "Over 90 days", format: "currency", width: "w-[140px]" },
  { key: "par_30", header: "PAR>30 %", format: "number", width: "w-[110px]" },
];

type Scope = "branch" | "officer";

export function ParAgingReport() {
  const { rows: data, isLoading, error } = useMfParAging();
  const { branches } = useBranches();
  const { getUserName } = useOrgMembers();
  const [scope, setScope] = useState<Scope>("branch");
  const asOf = format(new Date(), "d MMM yyyy");

  const grouped = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        loan_count: number;
        loans_in_arrears: number;
        portfolio_outstanding: number;
        current_outstanding: number;
        bucket_1_30: number;
        bucket_31_60: number;
        bucket_61_90: number;
        bucket_90_plus: number;
      }
    >();

    for (const r of data) {
      const key = (scope === "branch" ? r.branch_id : r.loan_officer_id) ?? "unassigned";
      const entry = map.get(key) ?? {
        key,
        loan_count: 0,
        loans_in_arrears: 0,
        portfolio_outstanding: 0,
        current_outstanding: 0,
        bucket_1_30: 0,
        bucket_31_60: 0,
        bucket_61_90: 0,
        bucket_90_plus: 0,
      };
      entry.loan_count += r.loan_count;
      entry.loans_in_arrears += r.loans_in_arrears;
      entry.portfolio_outstanding += r.portfolio_outstanding;
      entry.current_outstanding += r.current_outstanding;
      entry.bucket_1_30 += r.bucket_1_30;
      entry.bucket_31_60 += r.bucket_31_60;
      entry.bucket_61_90 += r.bucket_61_90;
      entry.bucket_90_plus += r.bucket_90_plus;
      map.set(key, entry);
    }

    return Array.from(map.values());
  }, [data, scope]);

  const label = useCallback(
    (key: string) => {
      if (key === "unassigned") return scope === "branch" ? "Unassigned branch" : "Unassigned";
      return scope === "branch"
        ? (branches.find((b) => b.id === key)?.name ?? "Unknown branch")
        : getUserName(key);
    },
    [scope, branches, getUserName],
  );

  const rows = useMemo<ReportRow[]>(() => {
    const par30 = (over30: number, portfolio: number) =>
      portfolio > 0 ? Number(((over30 / portfolio) * 100).toFixed(2)) : 0;

    const detail: ReportRow[] = grouped.map((g) => {
      const over30 = g.bucket_31_60 + g.bucket_61_90 + g.bucket_90_plus;
      return {
        id: g.key,
        kind: "detail",
        tone: par30(over30, g.portfolio_outstanding) > 5 ? "danger" : undefined,
        values: {
          scope: label(g.key),
          loan_count: g.loan_count,
          loans_in_arrears: g.loans_in_arrears,
          portfolio_outstanding: g.portfolio_outstanding,
          current_outstanding: g.current_outstanding,
          bucket_1_30: g.bucket_1_30,
          bucket_31_60: g.bucket_31_60,
          bucket_61_90: g.bucket_61_90,
          bucket_90_plus: g.bucket_90_plus,
          par_30: par30(over30, g.portfolio_outstanding),
        },
      };
    });

    if (detail.length === 0) return detail;

    const sum = (pick: (g: (typeof grouped)[number]) => number) =>
      grouped.reduce((s, g) => s + pick(g), 0);
    const portfolio = sum((g) => g.portfolio_outstanding);
    const over30 =
      sum((g) => g.bucket_31_60) + sum((g) => g.bucket_61_90) + sum((g) => g.bucket_90_plus);

    detail.push({
      id: "total",
      kind: "grandTotal",
      label: "Institution total",
      values: {
        scope: "Institution total",
        loan_count: sum((g) => g.loan_count),
        loans_in_arrears: sum((g) => g.loans_in_arrears),
        portfolio_outstanding: portfolio,
        current_outstanding: sum((g) => g.current_outstanding),
        bucket_1_30: sum((g) => g.bucket_1_30),
        bucket_31_60: sum((g) => g.bucket_31_60),
        bucket_61_90: sum((g) => g.bucket_61_90),
        bucket_90_plus: sum((g) => g.bucket_90_plus),
        par_30: par30(over30, portfolio),
      },
    });

    return detail;
  }, [grouped, label]);

  const getExportConfig = useCallback(
    (): ExportConfig => ({
      title: `PAR aging by ${scope}`,
      asOf,
      columns: toExportColumns(COLUMNS as ReportColumn<never>[]),
      rows: toExportRows(rows, COLUMNS as ReportColumn<never>[]),
      sheetName: "PAR aging",
    }),
    [rows, asOf, scope],
  );

  return (
    <ReportPageLayout
      title="PAR aging"
      description="Portfolio at risk split into days-past-due buckets"
      isLoading={isLoading}
      error={error}
      isEmpty={!isLoading && grouped.length === 0}
      emptyMessage="No outstanding portfolio to age"
      getExportConfig={getExportConfig}
      filters={
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-56 space-y-1.5">
            <Label>Group by</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="branch">Branch</SelectItem>
                <SelectItem value="officer">Loan officer</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      }
    >
      <ReportSurface title="PAR aging" asOfDate={`As of ${asOf}`}>
        <ReportTable columns={COLUMNS as ReportColumn<never>[]} rows={rows} />
      </ReportSurface>
    </ReportPageLayout>
  );
}

export default ParAgingReport;
