/**
 * PayrollReportReadinessChips — surfaces the report's lifecycle
 * preconditions (`payroll_approved`, `gl_posted`, `remittance_filed`) as
 * inline chips. Rendered next to the metadata band so an empty result
 * is diagnostic ("Waiting: GL not posted") instead of silent.
 */
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Clock } from "lucide-react";
import {
  DEPENDENCY_LABEL,
  type PayrollReportReadiness,
} from "@/hooks/payroll/usePayrollReportReadiness";
import type { PayrollReportDependency } from "@/hooks/payroll/usePayrollReportDefinitions";

interface Props {
  dependencies: PayrollReportDependency[];
  readiness: PayrollReportReadiness | undefined;
}

export function PayrollReportReadinessChips({ dependencies, readiness }: Props) {
  if (!dependencies.length) return null;
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {dependencies.map((dep) => {
        const state = readiness?.[dep] ?? "unknown";
        const isReady = state === "ready";
        const Icon = isReady ? CheckCircle2 : Clock;
        return (
          <Badge
            key={dep}
            variant={isReady ? "outline" : "secondary"}
            className="gap-1 font-normal"
          >
            <Icon className="h-3 w-3" />
            {isReady ? DEPENDENCY_LABEL[dep] : `Waiting: ${DEPENDENCY_LABEL[dep].toLowerCase()}`}
          </Badge>
        );
      })}
    </div>
  );
}

export default PayrollReportReadinessChips;
