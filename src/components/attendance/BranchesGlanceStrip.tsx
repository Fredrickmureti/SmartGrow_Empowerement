/**
 * BranchesGlanceStrip — multi-branch coverage glance for managers who
 * supervise more than one branch. Renders a single horizontal strip of
 * per-branch chips showing checked-in / total counts; clicking a chip
 * filters the roster to that branch via the existing `useBranches`
 * setter.
 *
 * Pure derivation from records already in memory — no extra query.
 */
import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBranches } from "@/hooks/useBranches";
import type { AttendanceRecord } from "@/hooks/useAttendance";

interface Props {
  records: AttendanceRecord[];
  totalsByBranch: Map<string, number>; // employee totals by branch_id
}

export function BranchesGlanceStrip({ records, totalsByBranch }: Props) {
  const { branches, currentBranch, switchBranch } = useBranches();

  // Only useful with multiple branches to compare.
  if (!branches || branches.length < 2) return null;

  const checkedInByBranch = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of records) {
      if (!r.branch_id) continue;
      if (r.clock_in && !r.clock_out) {
        m.set(r.branch_id, (m.get(r.branch_id) ?? 0) + 1);
      }
    }
    return m;
  }, [records]);

  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground mb-2">
          <Building2 className="h-3.5 w-3.5" />
          Branches at a glance
        </div>
        <div className="flex flex-wrap gap-2">
          {branches.map((b) => {
            const checkedIn = checkedInByBranch.get(b.id) ?? 0;
            const total = totalsByBranch.get(b.id) ?? 0;
            const coverage = total > 0 ? checkedIn / total : 0;
            const isActive = currentBranch?.id === b.id;
            const tone =
              total === 0
                ? "border-border text-muted-foreground"
                : coverage >= 0.75
                  ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300 bg-emerald-500/5"
                  : coverage >= 0.4
                    ? "border-amber-500/40 text-amber-700 dark:text-amber-300 bg-amber-500/5"
                    : "border-rose-500/40 text-rose-700 dark:text-rose-300 bg-rose-500/5";
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => !isActive && switchBranch(b.id)}
                disabled={isActive}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors",
                  isActive ? "ring-2 ring-primary/40 cursor-default" : "hover:bg-muted/50",
                  tone,
                )}
                title={isActive ? "Current branch" : `Switch to ${b.name}`}
              >
                <span className="font-medium">{b.name}</span>
                <span className="tabular-nums">
                  {checkedIn}
                  <span className="text-muted-foreground">/{total}</span>
                </span>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
