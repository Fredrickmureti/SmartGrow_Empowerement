/**
 * PayrollSetupGate
 *
 * Driven by the canonical readiness engine via `payroll_readiness_summary`
 * (which re-evaluates `payroll_readiness_rules` and reads back from
 * `payroll_readiness_findings`), NOT by `app_setup_status`.
 *
 * Contract:
 *   - If no readiness evaluation exists yet for the org → fail closed and
 *     offer an "Evaluate now" button (calls `evaluate_payroll_readiness`).
 *   - If block-severity findings exist → render an actionable checklist
 *     (rule_name + reason + remediation_link) and BLOCK children.
 *   - If no block findings → pass children through.
 *
 * Backend remains source of truth: `compute-payroll` calls
 * `assert_payroll_ready` which now delegates to the readiness engine.
 */
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ArrowRight, Loader2, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { usePayrollReadiness } from "@/hooks/payroll/usePayrollReadiness";

interface PayrollSetupGateProps {
  children: React.ReactNode;
  asCard?: boolean;
}

const DEFAULT_LINK = "/hr/payroll/readiness";

export function PayrollSetupGate({ children, asCard = false }: PayrollSetupGateProps) {
  // Pass `employeeIds: null` so the summary RPC evaluates the default
  // active-contract population — same set `compute-payroll` will check
  // when the user clicks "New Payroll Run". The badge therefore reflects
  // org + business + employee scopes, not just org.
  const {
    isLoading, hasEvaluation, isReady,
    orgBlockers, businessBlockers, employeeBlockers,
    evaluate,
  } = usePayrollReadiness({ employeeIds: null });
  const blockers = [...orgBlockers, ...businessBlockers];

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking payroll readiness…
        </CardContent>
      </Card>
    );
  }

  if (isReady) {
    return asCard ? (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CheckCircle2 className="h-4 w-4 text-primary" /> Payroll setup complete
          </CardTitle>
          <CardDescription>All readiness rules pass. You can run payroll.</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    ) : (
      <>{children}</>
    );
  }

  // Fail-closed: no findings yet — prompt to evaluate.
  if (!hasEvaluation) {
    return (
      <Card className="border-amber-500/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" /> Payroll readiness not evaluated
          </CardTitle>
          <CardDescription>
            Run a readiness check to see what's required before running payroll for this organization.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="sm" onClick={() => evaluate.mutate()} disabled={evaluate.isPending}>
            {evaluate.isPending ? (
              <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Evaluating…</>
            ) : (
              <><RefreshCw className="mr-2 h-3.5 w-3.5" /> Evaluate readiness</>
            )}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Has blockers — show actionable list.
  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4" /> Payroll setup required
        </CardTitle>
        <CardDescription>
          Resolve the following readiness blockers before you can run payroll. The payroll engine re-checks
          these on every run.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {blockers.map((b, idx) => (
          <div
            key={`${b.rule_code}-${idx}`}
            className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
              <div>
                <div className="font-medium">{b.rule_name}</div>
                <div className="text-muted-foreground">{b.reason}</div>
                {b.missing_fields && b.missing_fields.length > 0 && (
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Missing: {b.missing_fields.join(", ")}
                  </div>
                )}
              </div>
            </div>
            <Button size="sm" variant="outline" asChild>
              <Link to={b.remediation_link || DEFAULT_LINK}>
                {b.remediation_label || "Configure"} <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        ))}

        {employeeBlockers.length > 0 && (
          <div className="rounded-md border bg-muted/30 p-3 space-y-1">
            <div className="text-sm font-medium">
              {employeeBlockers.length} employee-level blocker(s)
            </div>
            <ul className="text-xs text-muted-foreground space-y-0.5 pl-4 list-disc">
              {employeeBlockers.slice(0, 5).map((b, i) => (
                <li key={`${b.subject_id}-${b.rule_code}-${i}`}>
                  <span className="text-foreground">{b.subject_label || "Employee"}</span>: {b.reason}
                  {b.remediation_link && (
                    <Link to={b.remediation_link} className="ml-1 text-primary hover:underline">
                      Fix
                    </Link>
                  )}
                </li>
              ))}
              {employeeBlockers.length > 5 && (
                <li>
                  …and {employeeBlockers.length - 5} more.{" "}
                  <Link to="/hr/payroll/readiness" className="text-primary hover:underline">
                    Review readiness
                  </Link>
                </li>
              )}
            </ul>
          </div>
        )}
        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-muted-foreground">
            Changes here take effect immediately — the engine re-checks readiness on every run.
          </p>
          <Button size="sm" variant="ghost" onClick={() => evaluate.mutate()} disabled={evaluate.isPending}>
            {evaluate.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
            )}
            Re-evaluate
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default PayrollSetupGate;
