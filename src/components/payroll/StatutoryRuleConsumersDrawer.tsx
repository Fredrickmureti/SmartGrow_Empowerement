/**
 * StatutoryRuleConsumersDrawer — "blast radius" surface for a single rule.
 *
 * Answers, in one place, the question every payroll administrator asks
 * before touching a statutory rule: *if I change this, what breaks?*
 * Driven by `v_payroll_statutory_rule_consumers` so it never duplicates
 * join logic in the UI.
 */
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, FileText, Banknote, Receipt, Calculator } from "lucide-react";
import { useStatutoryRuleConsumers } from "@/hooks/usePayrollStatutoryRuleStatus";

export function StatutoryRuleConsumersDrawer({
  open,
  onOpenChange,
  ruleId,
  ruleName,
  ruleCode,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  ruleId: string | null;
  ruleName?: string;
  ruleCode?: string | null;
}) {
  const { data, isLoading } = useStatutoryRuleConsumers(ruleId);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader className="pb-4">
          <SheetTitle>Downstream impact</SheetTitle>
          <SheetDescription>
            Everywhere <strong>{ruleName ?? "this rule"}</strong>
            {ruleCode ? <> (<code className="text-xs">{ruleCode}</code>)</> : null} is consumed
            inside the platform. Changes to this rule will affect every surface listed below
            on the next payroll run.
          </SheetDescription>
        </SheetHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">No consumer data available yet.</p>
        ) : (
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <FileText className="h-4 w-4" /> Payslip lines
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Last 12 months</span>
                  <span className="font-medium tabular-nums">{data.payslip_line_count_12m}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">All time</span>
                  <span className="font-medium tabular-nums">{data.payslip_line_count_total}</span>
                </div>
                <p className="text-xs text-muted-foreground pt-1">
                  Counted via <code>payslip_lines.rule_version_id</code>. Historical lines
                  remain pinned to the exact rule version that produced them.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Banknote className="h-4 w-4" /> General ledger account roles
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.gl_account_role_keys.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">
                    No matching pack account role keys.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {data.gl_account_role_keys.map((k) => (
                      <Badge key={k} variant="outline" className="text-xs">
                        <code className="text-[11px]">{k}</code>
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Receipt className="h-4 w-4" /> Remittance schedules
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.remittance_schedules.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">
                    No remittance schedule references this rule code.
                  </p>
                ) : (
                  <ul className="text-sm space-y-1">
                    {data.remittance_schedules.map((s) => (
                      <li key={s} className="flex items-center gap-2">
                        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                        {s}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Calculator className="h-4 w-4" /> Salary rules
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">References this rule</span>
                  <span className="font-medium tabular-nums">{data.salary_rule_count}</span>
                </div>
                <p className="text-xs text-muted-foreground pt-1">
                  Salary structure rules that read this statutory rule as their backing
                  computation source.
                </p>
              </CardContent>
            </Card>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
