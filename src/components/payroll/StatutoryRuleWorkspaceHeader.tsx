/**
 * StatutoryRuleWorkspaceHeader — the legislative cockpit summary strip.
 *
 * Communicates operational reality at a glance: installed pack pin, latest
 * published version available, count of pending upgrade proposals,
 * unresolved conflicts, and tenant overrides. One look should tell a
 * Payroll Administrator whether the workspace needs attention today.
 */
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Package, GitPullRequest, AlertTriangle, Pencil } from "lucide-react";
import { format } from "date-fns";
import type { StatutoryRuleStatus } from "@/hooks/usePayrollStatutoryRuleStatus";

export function StatutoryRuleWorkspaceHeader({
  statuses,
  pendingProposalCount,
  conflictCount,
}: {
  statuses: StatutoryRuleStatus[];
  pendingProposalCount: number;
  conflictCount: number;
}) {
  // Determine the dominant installed pack to show in the header.
  const pinned = statuses.find((s) => s.pinned_pack_id);
  const overrides = statuses.filter((s) => s.divergence === "tenant_override").length;
  const tenantAuthored = statuses.filter((s) => s.divergence === "tenant_authored").length;

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2 min-w-0">
            <Package className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <div className="text-sm min-w-0">
              <div className="text-muted-foreground text-xs">Installed pack</div>
              <div className="font-medium truncate">
                {pinned?.pinned_pack_name ?? "—"}
                {pinned?.pinned_pack_version ? (
                  <span className="text-muted-foreground"> · v{pinned.pinned_pack_version}</span>
                ) : null}
                {pinned?.pinned_installed_at ? (
                  <span className="text-xs text-muted-foreground ml-2">
                    installed {format(new Date(pinned.pinned_installed_at), "MMM d, yyyy")}
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          <div className="h-8 w-px bg-border hidden sm:block" />

          <HeaderStat
            icon={<GitPullRequest className="h-4 w-4" />}
            label="Pending upgrades"
            value={pendingProposalCount}
            tone={pendingProposalCount > 0 ? "sky" : "neutral"}
          />
          <HeaderStat
            icon={<AlertTriangle className="h-4 w-4" />}
            label="Conflicts"
            value={conflictCount}
            tone={conflictCount > 0 ? "rose" : "neutral"}
          />
          <HeaderStat
            icon={<Pencil className="h-4 w-4" />}
            label="Tenant overrides"
            value={overrides}
            tone={overrides > 0 ? "amber" : "neutral"}
          />
          {tenantAuthored > 0 ? (
            <Badge variant="outline" className="text-xs">
              {tenantAuthored} tenant-authored rule{tenantAuthored === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function HeaderStat({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: "neutral" | "sky" | "rose" | "amber";
}) {
  const toneClass =
    tone === "sky"
      ? "text-sky-700 dark:text-sky-300"
      : tone === "rose"
        ? "text-rose-700 dark:text-rose-300"
        : tone === "amber"
          ? "text-amber-700 dark:text-amber-300"
          : "text-muted-foreground";
  return (
    <div className="flex items-center gap-2">
      <span className={toneClass}>{icon}</span>
      <div className="text-sm leading-tight">
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className={`font-semibold tabular-nums ${value > 0 ? toneClass : ""}`}>{value}</div>
      </div>
    </div>
  );
}
