/**
 * PayrollGlReadinessBanner — proactive nudge shown at the top of payroll
 * pages when GL mappings are missing. Clicking the CTA dispatches the
 * `payroll:missing-mappings` event so the globally-mounted
 * MissingMappingsDialog opens with the live list + suggestions.
 */
import { AlertTriangle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  usePayrollGlReadiness,
  dispatchMissingMappings,
} from "@/hooks/payroll/usePayrollGlReadiness";

export function PayrollGlReadinessBanner() {
  const { missing, isLoading } = usePayrollGlReadiness();
  if (isLoading || missing.length === 0) return null;

  return (
    <Alert variant="destructive" className="mb-4">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>
        {missing.length} payroll GL mapping{missing.length === 1 ? "" : "s"} missing
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <p className="text-sm">
          Posting payroll to the ledger will fail until these are configured.
          We've pre-suggested accounts where possible — one click finishes setup.
        </p>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            dispatchMissingMappings({
              message: `${missing.length} GL mapping(s) missing. Pick or auto-create accounts to finish payroll setup.`,
              missing: missing.map((m) => ({
                setting_key: m.setting_key,
                label: m.label,
                rule_code: m.rule_code,
                kind: m.kind,
                suggested_account_id: m.suggested_account_id,
                suggested_account_label: m.suggested_account_label,
              })),
            })
          }
        >
          <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Fix mappings now
        </Button>
      </AlertDescription>
    </Alert>
  );
}