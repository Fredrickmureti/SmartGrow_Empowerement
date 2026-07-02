/**
 * PayrollMappingFindingsPanel — Wave-3 visible surface for
 * `payroll_mapping_findings`. Renders critical and warning role-violations
 * with deep links to the GL mapping editor. When `payrollRun` is supplied
 * and a critical finding exists for a posted run, exposes the "Fix posting"
 * CTA that triggers `payroll_generate_reclassification_je`.
 *
 * Mounted at:
 *   - HR → Payroll → Configuration → GL Account Mapping (full list)
 *   - HR → Payroll → Run detail dialog (filtered to that run's keys)
 */
import { useMemo, useState } from "react";
import { AlertTriangle, ShieldAlert, ArrowRight, Wrench, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  usePayrollMappingFindings,
  type PayrollMappingFinding,
} from "@/hooks/payroll/usePayrollMappingFindings";

interface PayrollMappingFindingsPanelProps {
  /** When supplied, restrict to setting_keys relevant to this run. */
  runSettingKeys?: string[];
  /**
   * When supplied AND the run is already posted, expose a "Fix posting" CTA
   * that posts a reclassification JE for that run. Reads `id` and
   * `payroll_number` for the confirm copy.
   */
  payrollRun?: { id: string; payroll_number: string; status: string } | null;
  /** Optional title override (defaults to "Payroll GL mapping issues"). */
  title?: string;
  /** When true, hide the panel entirely if there are no findings. */
  hideWhenClean?: boolean;
}

function severityLabel(code: string) {
  return code === "critical" ? "Critical" : code === "warning" ? "Warning" : code;
}

export function PayrollMappingFindingsPanel({
  runSettingKeys,
  payrollRun,
  title = "Payroll GL mapping issues",
  hideWhenClean = true,
}: PayrollMappingFindingsPanelProps) {
  const { rows, critical, warning, isLoading, reclassify } = usePayrollMappingFindings();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const filtered = useMemo<PayrollMappingFinding[]>(() => {
    if (!runSettingKeys || runSettingKeys.length === 0) return rows;
    const set = new Set(runSettingKeys);
    return rows.filter((r) => set.has(r.setting_key));
  }, [rows, runSettingKeys]);

  const filteredCritical = filtered.filter((f) => f.severity === "critical");
  const filteredWarning = filtered.filter((f) => f.severity === "warning");

  const showReclass =
    !!payrollRun &&
    (payrollRun.status === "posted" || payrollRun.status === "paid") &&
    filteredCritical.length > 0;

  if (isLoading) return null;
  if (filtered.length === 0 && hideWhenClean) return null;

  return (
    <Alert variant={filteredCritical.length > 0 ? "destructive" : "default"} className="mb-4">
      {filteredCritical.length > 0 ? (
        <ShieldAlert className="h-4 w-4" />
      ) : (
        <AlertTriangle className="h-4 w-4" />
      )}
      <AlertTitle className="flex items-center gap-2">
        {title}
        {filteredCritical.length > 0 && (
          <Badge variant="destructive">{filteredCritical.length} critical</Badge>
        )}
        {filteredWarning.length > 0 && (
          <Badge variant="outline">{filteredWarning.length} warning</Badge>
        )}
      </AlertTitle>
      <AlertDescription className="space-y-3 mt-2">
        <p className="text-sm">
          The accounts below are mapped to roles that violate accounting rules
          (e.g. salary expense routed to a Cost of Goods Sold account, or a
          statutory payable folded into generic Accounts Payable). Future
          payroll posts are blocked on critical issues; warnings are
          informational but should be cleaned up.
        </p>

        <ul className="space-y-2 text-sm">
          {filtered.map((f) => (
            <li
              key={`${f.setting_key}-${f.account_id}`}
              className="rounded-md border bg-background/60 p-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={f.severity === "critical" ? "destructive" : "outline"}>
                  {severityLabel(f.severity)}
                </Badge>
                <span className="font-mono text-xs">{f.setting_key}</span>
                <span className="text-muted-foreground">→</span>
                <span className="font-mono text-xs">{f.account_code}</span>
                <span className="truncate">{f.account_name}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{f.finding_detail}</p>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap gap-2 pt-1">
          <Button asChild size="sm" variant="secondary">
            <Link to="/hr/payroll/configuration/accounts" className="inline-flex items-center gap-1">
              Fix mappings <ArrowRight className="h-3 w-3" />
            </Link>
          </Button>

          {showReclass && (
            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={reclassify.isPending}
                >
                  {reclassify.isPending ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Wrench className="h-3 w-3 mr-1" />
                  )}
                  Post reclassification JE
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Post reclassification JE for {payrollRun!.payroll_number}?
                  </AlertDialogTitle>
                  <AlertDialogDescription className="space-y-2">
                    <span className="block">
                      This posts a balanced correction journal entry that
                      moves every payroll debit currently sitting on a Cost
                      of Goods Sold account to the salary expense account
                      you have mapped <strong>now</strong>.
                    </span>
                    <span className="block">
                      First make sure the salary_expense mapping points to a
                      compliant Payroll Expense account — if it still points
                      to COGS the operation will fail.
                    </span>
                    <span className="block">
                      The reclassification can only be performed once per
                      payroll run.
                    </span>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      reclassify.mutate(payrollRun!.id, {
                        onSuccess: () => setConfirmOpen(false),
                      });
                    }}
                  >
                    Post reclassification
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}

export default PayrollMappingFindingsPanel;