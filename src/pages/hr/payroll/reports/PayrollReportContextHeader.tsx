/**
 * PayrollReportContextHeader — anchors a payroll report to the payroll
 * run that produced its data. Shows the latest approved run whose period
 * intersects [dateFrom, dateTo] for the current tenant, with a link back
 * to the run.
 *
 * Readiness is NOT decided here. Whether the `payroll_approved`
 * dependency is satisfied comes from `payroll_report_readiness` (the same
 * server function that drives the readiness chips and the library cards),
 * so the banner and the chips can never contradict each other — the old
 * local `payroll_runs` query was a second, drifting source of truth.
 * This component's own query resolves only the run's IDENTITY (number,
 * period, link target) for display.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { format } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { ExternalLink, Info } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { PayrollReportDefinition } from "@/hooks/payroll/usePayrollReportDefinitions";
import type { PayrollReportReadiness } from "@/hooks/payroll/usePayrollReportReadiness";

interface Props {
  definition: PayrollReportDefinition;
  organizationId: string | undefined;
  businessId: string | undefined;
  dateFrom: string;
  dateTo: string;
  /** Canonical dependency states from `usePayrollReportReadiness`. */
  readiness: PayrollReportReadiness | undefined;
  /** True while the readiness probe is still resolving. */
  readinessLoading?: boolean;
}

interface RunRow {
  id: string;
  run_number: string | null;
  pay_period_start: string;
  pay_period_end: string;
  approved_at: string | null;
  approved_by: string | null;
}

export function PayrollReportContextHeader({
  definition,
  organizationId,
  businessId,
  dateFrom,
  dateTo,
  readiness,
  readinessLoading,
}: Props) {
  const dependsOnApproval = (definition.dependencies ?? []).includes(
    "payroll_approved",
  );
  const approvalState = readiness?.payroll_approved;

  const { data: run, isLoading } = useQuery<RunRow | null>({
    queryKey: [
      "payroll-report-source-run",
      organizationId,
      businessId,
      dateFrom,
      dateTo,
    ],
    enabled: !!organizationId && dependsOnApproval,
    queryFn: async () => {
      let q = (supabase as any)
        .from("payroll_runs")
        .select("id, run_number, pay_period_start, pay_period_end, approved_at, approved_by")
        .eq("organization_id", organizationId)
        .not("approved_at", "is", null)
        .lte("pay_period_start", dateTo)
        .gte("pay_period_end", dateFrom)
        .order("approved_at", { ascending: false })
        .limit(1);
      if (businessId) q = q.eq("business_id", businessId);
      const { data } = await q;
      return (Array.isArray(data) && data[0]) || null;
    },
  });

  if (!dependsOnApproval) return null;

  // Never flash a "nothing approved" banner while either probe is in flight.
  if (isLoading || readinessLoading) return null;

  // The banner is driven by the canonical readiness verdict; the run query
  // is only a display lookup and must not veto it.
  if (approvalState === "pending" || (approvalState !== "ready" && !run)) {
    return (
      <Card className="mb-4 border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-950/20">
        <CardContent className="flex items-start gap-3 py-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 flex-none text-amber-600 dark:text-amber-400" />
          <div>
            <div className="font-medium">No approved payroll run in this period</div>
            <div className="text-muted-foreground">
              This report shows data from approved payroll runs. Adjust the
              period, or approve a run to see figures here.
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Readiness says approved but the identity lookup found nothing (e.g. the
  // run sits outside this business scope) — show no anchor rather than crash.
  if (!run) return null;

  const label = run.run_number
    ? `Run ${run.run_number}`
    : `${format(new Date(run.pay_period_start), "MMM yyyy")} payroll`;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-card px-4 py-2 text-sm">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Source run
      </span>
      <Link
        to={`/hr/payroll/runs/${run.id}`}
        className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
      >
        {label}
        <ExternalLink className="h-3 w-3" />
      </Link>
      <span className="text-muted-foreground">
        Period {format(new Date(run.pay_period_start), "MMM d")} –{" "}
        {format(new Date(run.pay_period_end), "MMM d, yyyy")}
      </span>
      {run.approved_at && (
        <span className="text-muted-foreground">
          · Approved {format(new Date(run.approved_at), "MMM d, yyyy")}
        </span>
      )}
    </div>
  );
}

export default PayrollReportContextHeader;
