/**
 * ReportingBasisToggle — small inline switch shown above finance reports.
 * Lets the user flip between accrual (default) and cash basis.
 */
import { useReportingBasis } from "@/contexts/ReportingBasisContext";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Info } from "lucide-react";

export function ReportingBasisToggle() {
  const { basis, setBasis } = useReportingBasis();
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Reporting basis</span>
      <ToggleGroup
        type="single"
        size="sm"
        value={basis}
        onValueChange={(v) => v && setBasis(v as "accrual" | "cash")}
      >
        <ToggleGroupItem value="accrual" aria-label="Accrual basis">
          Accrual
        </ToggleGroupItem>
        <ToggleGroupItem value="cash" aria-label="Cash basis">
          Cash
        </ToggleGroupItem>
      </ToggleGroup>
      <Tooltip>
        <TooltipTrigger asChild>
          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="text-xs">
            <strong>Accrual</strong> recognises revenue when earned and
            expenses when incurred (default, GAAP/IFRS).
            <br />
            <strong>Cash</strong> recognises revenue and expenses only when
            money changes hands.
          </p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
