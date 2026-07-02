/**
 * EmployeeReadinessPanel — per-employee, structured payroll readiness.
 *
 * Renders the engine's findings verbatim. Every blocker exposes a
 * remediation link straight from `payroll_readiness_rules`. No regex,
 * no client-side rule logic.
 */
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Loader2, ArrowRight } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useEmployeeReadiness } from "@/hooks/payroll/useEmployeePayrollReadiness";
import { useBusinessModules } from "@/hooks/hr/useBusinessModules";

interface Props {
  employeeId: string;
}

function resolveLink(link: string | null, employeeId: string) {
  if (!link) return null;
  return link.replace(":employee_id", employeeId).replace("{employee_id}", employeeId);
}

export function EmployeeReadinessPanel({ employeeId }: Props) {
  const modules = useBusinessModules();
  const { data, isLoading } = useEmployeeReadiness(employeeId);

  if (modules.isReady && !modules.payroll) return null;

  if (isLoading || !data) {
    return (
      <Card>
        <CardContent className="p-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking payroll readiness…
        </CardContent>
      </Card>
    );
  }

  const blockers = data.findings.filter(
    (f) => f.status === "fail" && f.severity === "block",
  );
  const warnings = data.findings.filter(
    (f) => f.status === "fail" && f.severity === "warn",
  );
  const passes = data.findings.filter((f) => f.status === "pass");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {data.is_ready ? (
            <CheckCircle2 className="h-4 w-4 text-primary" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-amber-600" />
          )}
          Payroll readiness
        </CardTitle>
        <CardDescription className="text-xs">
          {passes.length} passing · {warnings.length} warnings · {blockers.length} blocking
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.is_ready && blockers.length === 0 && warnings.length === 0 && (
          <p className="text-sm text-muted-foreground">All readiness checks pass.</p>
        )}

        {[...blockers, ...warnings].map((f, idx) => {
          const link = resolveLink(f.remediation_link, employeeId);
          return (
            <div
              key={`${f.rule_code}-${idx}`}
              className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="text-sm">
                <div className="font-medium flex items-center gap-2">
                  <AlertTriangle
                    className={`h-3.5 w-3.5 ${f.severity === "block" ? "text-destructive" : "text-amber-600"}`}
                  />
                  {f.rule_name}
                  <Badge variant={f.severity === "block" ? "destructive" : "secondary"} className="text-[10px]">
                    {f.severity === "block" ? "Blocks payroll" : "Warning"}
                  </Badge>
                </div>
                <div className="text-muted-foreground">{f.reason}</div>
                {f.missing_fields && f.missing_fields.length > 0 && (
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Missing: {f.missing_fields.join(", ")}
                  </div>
                )}
              </div>
              {link && (
                <Button size="sm" variant="outline" asChild>
                  <Link to={link}>
                    {f.remediation_label || "Fix"}{" "}
                    <ArrowRight className="ml-1 h-3.5 w-3.5" />
                  </Link>
                </Button>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export default EmployeeReadinessPanel;
