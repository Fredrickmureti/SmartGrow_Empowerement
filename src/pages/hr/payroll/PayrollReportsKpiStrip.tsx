/**
 * PayrollReportsKpiStrip — enterprise-grade workspace header for the
 * Payroll Reports page.
 *
 * Replaces the previous "blank list under a tab bar" behaviour with a
 * live KPI strip that reflects real payroll business events for the
 * currently scoped organization + business + date window:
 *
 *   • Payroll runs in window (count + latest status)
 *   • Employees paid          (distinct employee_id on payslips)
 *   • Gross payroll           (sum of payslips.gross_pay)
 *   • Outstanding liabilities (payroll_remittances not yet paid)
 *
 * This is Phase 3 (dashboard) of the Payroll Reports enterprise redesign
 * plan. Later phases add the trend charts, favourite / scheduled report
 * shelves, and compliance-due chips on top of this strip.
 *
 * Country-agnostic: reads only header-level totals and
 * `payroll_remittances.status` — no rule codes, no identifiers, no
 * currency assumptions beyond the business base currency (rendered
 * through the existing `useCurrency` hook).
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { usePermissions } from "@/hooks/usePermissions";

interface Props {
  dateFrom: string;
  dateTo: string;
}

interface PayrollWorkspaceKpis {
  runCount: number;
  latestRunStatus: string | null;
  employeeCount: number;
  grossTotal: number;
  outstandingLiabilities: number;
  outstandingLiabilityAmount: number;
}

export function PayrollReportsKpiStrip({ dateFrom, dateTo }: Props) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency } = useCurrency();
  const { can } = usePermissions();
  const canSeeMoney = can("viewSalaryDetails");

  const { data, isLoading } = useQuery<PayrollWorkspaceKpis>({
    queryKey: ["payroll-reports-kpi", currentOrg?.id, currentBusiness?.id, dateFrom, dateTo],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      // Runs in window
      let runQ = supabase
        .from("payroll_runs")
        .select("id, status, pay_period_end")
        .eq("organization_id", currentOrg!.id)
        .lte("pay_period_start", dateTo)
        .gte("pay_period_end", dateFrom);
      if (currentBusiness?.id) runQ = runQ.eq("business_id", currentBusiness.id);
      const { data: runs = [] } = await runQ;
      const runIds = runs.map((r: any) => r.id);
      const latest = [...runs].sort((a: any, b: any) =>
        String(b.pay_period_end).localeCompare(String(a.pay_period_end)),
      )[0];

      // Payslip aggregates (header-level totals only — country-agnostic)
      let empCount = 0;
      let gross = 0;
      if (runIds.length) {
        const { data: payslips = [] } = await supabase
          .from("payslips")
          .select("employee_id, gross_pay")
          .in("payroll_run_id", runIds);
        const emp = new Set<string>();
        for (const p of payslips as any[]) {
          emp.add(p.employee_id);
          gross += Number(p.gross_pay || 0);
        }
        empCount = emp.size;
      }

      // Outstanding statutory / remittance liabilities in the same window
      let outstandingCount = 0;
      let outstandingAmt = 0;
      if (runIds.length) {
        const { data: rems = [] } = await supabase
          .from("payroll_remittances")
          .select("amount, employer_amount, status")
          .in("payroll_run_id", runIds)
          .neq("status", "paid");
        outstandingCount = rems.length;
        for (const r of rems as any[]) {
          outstandingAmt += Number(r.amount || 0) + Number(r.employer_amount || 0);
        }
      }

      return {
        runCount: runs.length,
        latestRunStatus: latest?.status ?? null,
        employeeCount: empCount,
        grossTotal: gross,
        outstandingLiabilities: outstandingCount,
        outstandingLiabilityAmount: outstandingAmt,
      };
    },
  });

  const kpis = useMemo(
    () => data ?? {
      runCount: 0,
      latestRunStatus: null,
      employeeCount: 0,
      grossTotal: 0,
      outstandingLiabilities: 0,
      outstandingLiabilityAmount: 0,
    },
    [data],
  );

  const statusVariant = (s: string | null): "default" | "secondary" | "outline" => {
    if (!s) return "outline";
    if (["paid", "posted", "approved", "completed"].includes(s)) return "default";
    return "secondary";
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
      <KpiCard
        label="Payroll runs in window"
        primary={String(kpis.runCount)}
        secondary={
          kpis.latestRunStatus ? (
            <Badge variant={statusVariant(kpis.latestRunStatus)} className="font-normal">
              Latest: {kpis.latestRunStatus}
            </Badge>
          ) : (
            <span className="text-muted-foreground text-xs">No runs</span>
          )
        }
        loading={isLoading}
      />
      <KpiCard
        label="Employees paid"
        primary={String(kpis.employeeCount)}
        secondary={<span className="text-muted-foreground text-xs">distinct headcount</span>}
        loading={isLoading}
      />
      <KpiCard
        label="Gross payroll"
        primary={canSeeMoney ? formatCurrency(kpis.grossTotal) : "—"}
        secondary={
          canSeeMoney ? (
            <span className="text-muted-foreground text-xs">in period</span>
          ) : (
            <Badge variant="secondary" className="font-normal">Hidden</Badge>
          )
        }
        loading={isLoading}
      />
      <KpiCard
        label="Outstanding liabilities"
        primary={String(kpis.outstandingLiabilities)}
        secondary={
          canSeeMoney && kpis.outstandingLiabilityAmount > 0 ? (
            <span className="text-muted-foreground text-xs">
              {formatCurrency(kpis.outstandingLiabilityAmount)} due
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">
              {kpis.outstandingLiabilities === 0 ? "All settled" : "amount hidden"}
            </span>
          )
        }
        loading={isLoading}
      />
    </div>
  );
}

function KpiCard({
  label,
  primary,
  secondary,
  loading,
}: {
  label: string;
  primary: string;
  secondary: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">
          {loading ? <span className="text-muted-foreground">…</span> : primary}
        </div>
        <div className="mt-1">{secondary}</div>
      </CardContent>
    </Card>
  );
}

export default PayrollReportsKpiStrip;