/**
 * Round 11 Step 1 — RuleSimulator panel.
 *
 * Renders inside RuleForm whenever a schema has resolved. Lets a
 * non-technical user enter a sample salary and immediately see how the
 * rule they're configuring would deduct/contribute, with a band-by-band
 * breakdown and a human-readable explanation. Pure client-side preview —
 * production payroll still runs server-side via `compute-payroll`.
 */
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Calculator, AlertTriangle } from "lucide-react";
import { simulateRule, type SimulatorInputs, type SimulationResult } from "../lib/ruleSimulator";
import { BreakdownTable } from "./widgets/BreakdownTable";

interface Props {
  rule_type: string;
  parameters: any;
  /** Optional ISO currency code displayed alongside amounts. */
  currency?: string;
}

const STORAGE_KEY = "localization.ruleSimulator.inputs.v1";

function loadInputs(): SimulatorInputs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { gross: 50000, period: "monthly", housing: 0, pension: 0 };
}

export function RuleSimulator({ rule_type, parameters, currency }: Props) {
  const [inputs, setInputs] = useState<SimulatorInputs>(() => loadInputs());
  const [result, setResult] = useState<SimulationResult | null>(null);

  // Persist sample inputs across sessions.
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(inputs)); } catch { /* ignore */ }
  }, [inputs]);

  // Auto-recompute on parameter change so the preview stays live.
  const paramsKey = useMemo(() => {
    try { return JSON.stringify(parameters); } catch { return ""; }
  }, [parameters]);
  useEffect(() => {
    if (!parameters?.type) { setResult(null); return; }
    setResult(simulateRule(rule_type, parameters, inputs));
  }, [rule_type, paramsKey, inputs]);

  const employeeRows = result?.breakdown.filter((r) => r.side === "employee") ?? [];
  const employerRows = result?.breakdown.filter((r) => r.side === "employer") ?? [];

  return (
    <Card className="border-dashed">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Calculator className="h-4 w-4" />
          Test this rule on a sample salary
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Preview how the rule will deduct or contribute before you save it. Production payroll always re-runs the
          authoritative engine — this is a guided preview to help you avoid mistakes.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Gross salary</Label>
            <NumericInput
              min={0}
              value={inputs.gross ?? 0}
              onValueChange={(n) => setInputs({ ...inputs, gross: n ?? 0 })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Pension contribution</Label>
            <NumericInput
              min={0}
              value={inputs.pension ?? 0}
              onValueChange={(n) => setInputs({ ...inputs, pension: n ?? 0 })}
            />
          </div>
        </div>

        {!parameters?.type ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              Pick a computation kind above to preview this rule.
            </AlertDescription>
          </Alert>
        ) : result?.warnings.length ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs space-y-1">
              {result.warnings.map((w, i) => <div key={i}>{w}</div>)}
            </AlertDescription>
          </Alert>
        ) : null}

        {result && (
          <BreakdownTable
            employeeRows={employeeRows.map((r) => ({ label: r.label, amount: r.amount, rate: r.rate, base: r.base }))}
            employerRows={employerRows.map((r) => ({ label: r.label, amount: r.amount, rate: r.rate, base: r.base }))}
            employeeTotal={result.employee_amount}
            employerTotal={result.employer_amount}
            explanation={result.explanation}
            currency={currency}
          />
        )}

        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setInputs({ gross: 50000, period: "monthly", housing: 0, pension: 0 })}
          >
            Reset sample
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
