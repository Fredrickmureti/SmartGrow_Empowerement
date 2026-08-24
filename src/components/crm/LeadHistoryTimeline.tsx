/**
 * Lifecycle history for a lead/opportunity.
 *
 * Renders the append-only `crm_lead_history` log: what changed, who changed it
 * and why. Presentation only — the log itself is server-written and immutable.
 */
import { format } from "date-fns";
import { History, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useLeadHistory, type LeadHistoryEntry } from "@/hooks/crm/useLeadHistory";

const EVENT_LABELS: Record<string, string> = {
  qualified: "Qualified",
  stage_changed: "Stage changed",
  won: "Won",
  lost: "Lost",
  reopened: "Reopened",
  reassigned: "Owner changed",
  revalued: "Value changed",
  archived: "Archived",
  branch_transferred: "Branch transferred",
};

function describe(
  entry: LeadHistoryEntry,
  stageName: (id: string | null) => string,
  branchName: (id: string | null) => string,
): string | null {
  switch (entry.event) {
    case "stage_changed":
      return `${stageName(entry.from_stage_id)} → ${stageName(entry.to_stage_id)}`;
    case "revalued":
      return `${entry.from_value ?? 0} → ${entry.to_value ?? 0}`;
    case "branch_transferred":
      return `${branchName(entry.from_branch_id)} → ${branchName(entry.to_branch_id)}`;
    case "won":
    case "lost":
    case "qualified":
    case "reopened":
      return `${entry.from_status ?? "—"} → ${entry.to_status ?? "—"}`;
    default:
      return null;
  }
}

interface LeadHistoryTimelineProps {
  leadId: string | null | undefined;
  enabled?: boolean;
  stageNames?: Record<string, string>;
}

export function LeadHistoryTimeline({ leadId, enabled = true, stageNames }: LeadHistoryTimelineProps) {
  const { history, isLoading } = useLeadHistory(leadId, enabled);
  const { branches } = useBranch();
  const stageName = (id: string | null) => (id ? stageNames?.[id] ?? "—" : "—");
  const branchName = (id: string | null) =>
    id ? branches.find((b) => b.id === id)?.name ?? "—" : "—";

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
        <History className="h-5 w-5" />
        No lifecycle changes recorded yet.
      </div>
    );
  }

  return (
    <ol className="space-y-3">
      {history.map((entry) => {
        const detail = describe(entry, stageName);
        return (
          <li key={entry.id} className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{EVENT_LABELS[entry.event] ?? entry.event}</Badge>
              {detail && <span className="text-sm text-muted-foreground">{detail}</span>}
              <span className="ml-auto text-xs text-muted-foreground">
                {format(new Date(entry.occurred_at), "dd MMM yyyy HH:mm")}
              </span>
            </div>
            {entry.reason && <p className="mt-2 text-sm">{entry.reason}</p>}
          </li>
        );
      })}
    </ol>
  );
}
