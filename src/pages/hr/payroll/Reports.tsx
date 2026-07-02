/**
 * PayrollReportsPage — Stage 4.
 *
 * Real reports surface wired through the shared render-report engine.
 * No parallel reporting logic. Filter context, branch filter, and
 * ReportPageLayout export config are all reused so PDF/CSV/Excel
 * inherit business + scope labelling and the masthead.
 *
 * Six keys (server-side builders live in
 * supabase/functions/_shared/reports/payrollData.ts):
 *   - payroll_register
 *   - payroll_summary
 *   - employer_contributions
 *   - statutory_liabilities
 *   - employee_earnings
 *   - branch_payroll_cost
 */
import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { ReportFilterProvider, useReportFilters } from "@/contexts/ReportFilterContext";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePermissions } from "@/hooks/usePermissions";
import { useCurrency } from "@/hooks/useCurrency";
import { useNavigate } from "react-router-dom";
import { format, startOfMonth, endOfMonth } from "date-fns";
import type { ExportConfig, ExportRow } from "@/services/reports/ReportExportService";

type ReportKey =
  | "payroll_register"
  | "payroll_summary"
  | "employer_contributions"
  | "statutory_liabilities"
  | "employee_earnings"
  | "branch_payroll_cost"
  | "department_payroll_cost"
  | "payroll_overtime"
  | "payroll_variance";

/**
 * Tab ordering mirrors the enterprise payroll-reporting mental model:
 *   Operate        → Register, Summary, Employee Earnings, Overtime
 *   Compliance     → Employer Contributions, Statutory Liabilities
 *   Cost Analysis  → Branch / Department Payroll Cost, Variance
 *
 * Each group renders as its own tabs row so payroll officers see the
 * report families at a glance — no mixed alphabetical wall of tabs.
 */
const TAB_GROUPS: { label: string; items: { key: ReportKey; label: string }[] }[] = [
  {
    label: "Operate",
    items: [
      { key: "payroll_register",       label: "Register" },
      { key: "payroll_summary",        label: "Summary" },
      { key: "employee_earnings",      label: "Employee Earnings" },
      { key: "payroll_overtime",       label: "Overtime" },
    ],
  },
  {
    label: "Compliance",
    items: [
      { key: "employer_contributions", label: "Employer Contributions" },
      { key: "statutory_liabilities",  label: "Statutory Liabilities" },
    ],
  },
  {
    label: "Cost Analysis",
    items: [
      { key: "branch_payroll_cost",     label: "By Branch" },
      { key: "department_payroll_cost", label: "By Department" },
      { key: "payroll_variance",        label: "Variance" },
    ],
  },
];

const TITLE: Record<ReportKey, string> = {
  payroll_register: "Payroll Register",
  payroll_summary: "Payroll Summary",
  employer_contributions: "Employer Contributions",
  statutory_liabilities: "Statutory Liabilities",
  employee_earnings: "Employee Earnings",
  branch_payroll_cost: "Branch Payroll Cost",
  department_payroll_cost: "Department Payroll Cost",
  payroll_overtime: "Overtime Report",
  payroll_variance: "Payroll Variance",
};

function PayrollReportsInner() {
  const now = new Date();
  const { filters } = useReportFilters();
  const [reportKey, setReportKey] = useState<ReportKey>("payroll_register");
  const [dateFrom, setDateFrom] = useState(filters.dateFrom || format(startOfMonth(now), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(filters.dateTo || format(endOfMonth(now), "yyyy-MM-dd"));
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { can } = usePermissions();
  const { formatCurrency } = useCurrency();
  const navigate = useNavigate();
  const canSeeMoney = can("viewSalaryDetails");

  const { data, isLoading, error } = useQuery({
    queryKey: ["payroll-report", reportKey, currentOrg?.id, currentBusiness?.id, filters.branchId, dateFrom, dateTo],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("render-report", {
        body: {
          reportType: reportKey,
          organizationId: currentOrg!.id,
          businessId: currentBusiness?.id,
          dateFrom,
          dateTo,
          format: "json",
          filters: { branchId: filters.branchId },
        },
      });
      if (error) throw error;
      return data as { columns?: { key: string; header: string; format?: string; align?: string }[]; data: any[] };
    },
  });

  const rows: any[] = data?.data ?? [];
  const columns = data?.columns ?? [];

  const isMoneyCol = (col: { format?: string; key: string }) =>
    col.format === "currency" || /amount|total|gross|net|pay|cost/i.test(col.key);

  const renderCell = (row: any, col: { key: string; format?: string }) => {
    const v = row[col.key];
    if (v == null || v === "") return "—";
    if (isMoneyCol(col)) {
      return canSeeMoney ? formatCurrency(Number(v) || 0) : <Badge variant="secondary" className="font-normal">Hidden</Badge>;
    }
    return String(v);
  };

  const handleRowClick = (row: any) => {
    const meta = (row as any)._meta;
    if (!meta) return;
    if (meta.sourceDocType === "payslip" && meta.sourceDocId) navigate(`/hr/payroll/payslips/${meta.sourceDocId}`);
    else if (meta.sourceDocType === "payroll_run" && meta.sourceDocId) navigate(`/hr/payroll/runs/${meta.sourceDocId}`);
    else if (meta.sourceDocType === "payroll_liability" && meta.ruleCode) navigate(`/hr/payroll/remittances?ruleCode=${encodeURIComponent(meta.ruleCode)}`);
  };

  const getExportConfig = useCallback((): ExportConfig => {
    const exportRows: ExportRow[] = rows.map((r) => {
      const out: any = {};
      for (const c of columns) {
        out[c.key] = isMoneyCol(c) && !canSeeMoney ? null : r[c.key];
      }
      return out;
    });
    return {
      title: TITLE[reportKey],
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
      columns: columns.map((c) => ({
        key: c.key,
        header: c.header,
        format: (c.format as any) ?? undefined,
        align: (c.align as any) ?? undefined,
      })),
      rows: exportRows,
      sheetName: TITLE[reportKey],
    };
  }, [rows, columns, reportKey, dateFrom, dateTo, currentOrg, canSeeMoney]);

  return (
    <ReportPageLayout
      title="Payroll Reports"
      description="Payroll-owned reporting: payroll registers and summaries, employee earnings, employer contributions, statutory liabilities, and branch payroll cost."
      isLoading={isLoading}
      error={error as Error | null}
      isEmpty={!isLoading && rows.length === 0}
      getExportConfig={getExportConfig}
      filters={
        <ReportFilters dateFrom={dateFrom} dateTo={dateTo} onDateFromChange={setDateFrom} onDateToChange={setDateTo}>
          <ReportBranchFilter reportKind="journal" />
        </ReportFilters>
      }
    >
      <div className="space-y-3 mb-4">
        {TAB_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5">
              {group.label}
            </div>
            <Tabs value={reportKey} onValueChange={(v) => setReportKey(v as ReportKey)}>
              <TabsList className="flex-wrap h-auto">
                {group.items.map((t) => (
                  <TabsTrigger key={t.key} value={t.key}>{t.label}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        ))}
      </div>
      <Card>
        <CardContent className="pt-6">
          <div className="text-sm text-muted-foreground mb-3">{rows.length} rows</div>
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => (
                  <TableHead key={c.key} className={c.align === "right" ? "text-right" : undefined}>{c.header}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i} className="cursor-pointer hover:bg-muted/50" onClick={() => handleRowClick(r)}>
                  {columns.map((c) => (
                    <TableCell key={c.key} className={c.align === "right" ? "text-right" : undefined}>
                      {renderCell(r, c)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </ReportPageLayout>
  );
}

export function PayrollReportsPage() {
  return (
    <ReportFilterProvider>
      <PayrollReportsInner />
    </ReportFilterProvider>
  );
}

export default PayrollReportsPage;
