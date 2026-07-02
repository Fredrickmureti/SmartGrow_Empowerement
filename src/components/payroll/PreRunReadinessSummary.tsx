/**
 * PreRunReadinessSummary
 *
 * Inline summary shown inside CreatePayrollDialog. Surfaces org +
 * business + per-employee blockers from `payroll_readiness_summary`
 * — the same engine `assert_payroll_ready_json` uses in
 * `compute-payroll`. The badge here can never disagree with the
 * server-side gate that runs at submit.
 */
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Loader2, ArrowRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOrganization } from "@/hooks/useOrganization";
import { usePayrollReadiness } from "@/hooks/payroll/usePayrollReadiness";

interface Props {
  /** Effective employee ids that the run will target. Empty → "all active". */
  employeeIds: string[];
  /** True while the dialog is open — gates the evaluation. */
  active: boolean;
  /** Payroll period being prepared — forwarded to the readiness page link. */
  periodStart?: string;
  periodEnd?: string;
}

export function PreRunReadinessSummary({ employeeIds, active, periodStart, periodEnd }: Props) {
  const { currentOrg } = useOrganization();

  // Pass the actual selection — the summary RPC re-evaluates findings
  // for these employees on every call.
  const r = usePayrollReadiness({
    employeeIds: employeeIds.length ? employeeIds : null,
    enabled: active && !!currentOrg?.id,
  });

  const reviewHref = (() => {
    const qs = new URLSearchParams();
    if (periodStart) qs.set("period_start", periodStart);
    if (periodEnd) qs.set("period_end", periodEnd);
    const s = qs.toString();
    return s ? `/hr/payroll/readiness?${s}` : "/hr/payroll/readiness";
  })();

  if (!currentOrg?.id) return null;

  if (r.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking payroll readiness…
      </div>
    );
  }

  const orgBlockers = r.orgBlockers;
  const businessBlockers = r.businessBlockers;
  const empBlockers = r.employeeBlockers;
  const allClear = r.isReady;

  return (
    <div className="rounded-md border bg-muted/30 p-2.5 text-xs space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium flex items-center gap-1.5">
          {allClear ? (
            <>
              <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
              Payroll readiness — all checks pass
            </>
          ) : (
            <>
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
              Payroll readiness — issues to resolve
            </>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={() => r.refetch()}
          disabled={r.isLoading}
        >
          <RefreshCw className="mr-1 h-3 w-3" /> Re-check
        </Button>
      </div>

      {[...orgBlockers, ...businessBlockers].map((b, i) => (
        <div key={`${b.scope}-${b.rule_code}-${i}`} className="flex items-start justify-between gap-2">
          <div className="text-muted-foreground">
            <span className="font-medium text-foreground">{b.rule_name}.</span> {b.reason}
          </div>
          {b.remediation_link && (
            <Button size="sm" variant="ghost" asChild className="h-6 px-2 text-[11px]">
              <Link to={b.remediation_link}>
                {b.remediation_label || "Fix"} <ArrowRight className="ml-1 h-3 w-3" />
              </Link>
            </Button>
          )}
        </div>
      ))}

      {empBlockers.length > 0 && (
        <div className="space-y-1">
          <div className="text-muted-foreground">
            {empBlockers.length} blocker(s) across selected employee(s):
          </div>
          <ul className="space-y-0.5 pl-3 list-disc">
            {empBlockers.slice(0, 5).map((b, i) => (
              <li key={`${b.subject_id}-${b.rule_code}-${i}`} className="text-muted-foreground">
                <span className="text-foreground">{b.subject_label || "Employee"}</span>: {b.reason}
                {b.remediation_link && (
                  <Link to={b.remediation_link} className="ml-1 text-primary hover:underline">
                    Fix <ArrowRight className="inline h-3 w-3" />
                  </Link>
                )}
              </li>
            ))}
            {empBlockers.length > 5 && (
              <li className="text-muted-foreground">
                …and {empBlockers.length - 5} more.{" "}
                <Link to={reviewHref} className="text-primary hover:underline">
                  Review readiness
                </Link>
              </li>
            )}
          </ul>
        </div>
      )}

      {!allClear && (
        <p className="text-[11px] text-muted-foreground">
          The payroll engine re-checks these on submit and will block the run if anything still fails.
        </p>
      )}
    </div>
  );
}

export default PreRunReadinessSummary;
