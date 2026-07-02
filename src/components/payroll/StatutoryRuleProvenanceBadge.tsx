/**
 * Visual badge that communicates *where this statutory rule came from* and
 * *what state it is in vs. its pack snapshot*.
 *
 * Powered by the `divergence` column of `v_payroll_statutory_rule_status`.
 * One badge per row replaces the silent "we have no idea where this came
 * from" UX of the legacy CRUD page.
 */
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Building2, GitBranch, Pencil, AlertTriangle, Clock } from "lucide-react";
import type { StatutoryRuleDivergence, StatutoryRuleStatus } from "@/hooks/usePayrollStatutoryRuleStatus";

const STYLES: Record<
  StatutoryRuleDivergence,
  { label: string; className: string; icon: React.ComponentType<{ className?: string }>; tooltip: string }
> = {
  pack_clean: {
    label: "Pack",
    className: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800",
    icon: Building2,
    tooltip: "Shipped by the installed localization pack. Unmodified.",
  },
  tenant_override: {
    label: "Override",
    className: "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/30 dark:text-amber-200 dark:border-amber-800",
    icon: Pencil,
    tooltip: "This rule was changed locally and now diverges from the pack snapshot.",
  },
  pending_upgrade: {
    label: "Upgrade pending",
    className: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/30 dark:text-sky-300 dark:border-sky-800",
    icon: Clock,
    tooltip: "A newer pack version has a change for this rule waiting in the upgrade inbox.",
  },
  conflict: {
    label: "Conflict",
    className: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/30 dark:text-rose-300 dark:border-rose-800",
    icon: AlertTriangle,
    tooltip: "A pack upgrade clashed with a local change here. Open the Conflicts tab to resolve.",
  },
  tenant_authored: {
    label: "Tenant rule",
    className: "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/40 dark:text-slate-300 dark:border-slate-700",
    icon: GitBranch,
    tooltip: "Created in this workspace — not part of any installed localization pack.",
  },
};

export function StatutoryRuleProvenanceBadge({
  status,
  showVersion = true,
}: {
  status: Pick<StatutoryRuleStatus, "divergence" | "pinned_pack_version" | "pending_to_version">;
  showVersion?: boolean;
}) {
  const style = STYLES[status.divergence];
  const Icon = style.icon;
  const version =
    status.divergence === "pending_upgrade" && status.pending_to_version
      ? ` → v${status.pending_to_version}`
      : showVersion && status.pinned_pack_version
        ? ` v${status.pinned_pack_version}`
        : "";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={`gap-1 ${style.className}`}>
          <Icon className="h-3 w-3" />
          <span className="text-[11px] font-medium">
            {style.label}
            {version}
          </span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        {style.tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
