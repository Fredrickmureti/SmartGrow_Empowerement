/**
 * Setup-health pill for the Employees directory (Wave G F2).
 *
 * Compact visual signal of payroll readiness. Colors use the design
 * system semantic tokens (success/warning/destructive/muted) — no raw
 * Tailwind palette classes.
 */
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertTriangle, AlertOctagon, MinusCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { SetupVerdict, SetupHealthRow } from "@/hooks/hr/useEmployeeSetupHealth";

interface Props {
  row?: SetupHealthRow;
  compact?: boolean;
}

const STYLES: Record<SetupVerdict, string> = {
  ready: "bg-success/10 text-success border-success/20",
  incomplete: "bg-warning/10 text-warning border-warning/20",
  blocked: "bg-destructive/10 text-destructive border-destructive/20",
  inactive: "bg-muted text-muted-foreground border-transparent",
};

const ICONS: Record<SetupVerdict, typeof CheckCircle2> = {
  ready: CheckCircle2,
  incomplete: AlertTriangle,
  blocked: AlertOctagon,
  inactive: MinusCircle,
};

const LABELS: Record<SetupVerdict, string> = {
  ready: "Ready",
  incomplete: "Incomplete",
  blocked: "Blocked",
  inactive: "Inactive",
};

export function SetupHealthPill({ row, compact }: Props) {
  if (!row) return null;
  const Icon = ICONS[row.verdict];
  const summary = (() => {
    const parts: string[] = [];
    if (!row.has_active_employment) parts.push("no active employment");
    if (!row.has_active_contract) parts.push("no active contract");
    if (row.open_blocking_findings > 0) parts.push(`${row.open_blocking_findings} blocker(s)`);
    if (row.open_warn_findings > 0) parts.push(`${row.open_warn_findings} warning(s)`);
    return parts.length === 0 ? "All checks pass" : parts.join(" · ");
  })();

  const badge = (
    <Badge variant="outline" className={`${STYLES[row.verdict]} gap-1 font-medium`}>
      <Icon className="h-3 w-3" />
      {!compact && LABELS[row.verdict]}
    </Badge>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" aria-label={`Setup ${LABELS[row.verdict]}: ${summary}`}>
          {badge}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <div className="text-xs">
          <div className="font-medium">{LABELS[row.verdict]}</div>
          <div className="text-muted-foreground">{summary}</div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
