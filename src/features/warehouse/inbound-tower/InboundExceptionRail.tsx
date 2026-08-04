/**
 * Inbound exception rail — the escalations a receiving supervisor owns.
 *
 * Exceptions are the platform's single record of "something went wrong on
 * the floor"; the tower does not fork that model and does not classify
 * exception text in the client — it reads the open rows and links each one
 * into the exceptions inbox, which owns triage, assignment and resolution.
 */
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState, LoadingState } from "@/design-system";
import { humanise, severityLabel, shortDuration } from "@/features/warehouse/exceptions/constants";
import { useInboundExceptions } from "./useInboundTower";

export function InboundExceptionRail({
  warehouseId, limit = 8,
}: { warehouseId?: string; limit?: number }) {
  const { data, isLoading } = useInboundExceptions({ warehouseId });

  if (isLoading) return <LoadingState />;

  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No open inbound exceptions"
        description="Nothing has been raised against gate, receiving, QC or put-away."
      />
    );
  }

  const now = Date.now();

  return (
    <ul className="divide-y rounded-lg border">
      {rows.slice(0, limit).map((e) => {
        const overdue = !!e.due_by && new Date(e.due_by).getTime() < now;
        return (
          <li key={e.id}>
            <Link
              to="/warehouse-app/exceptions"
              className="flex items-center gap-3 p-3 transition-colors hover:bg-muted/50"
            >
              <span
                className={cn(
                  "w-1 shrink-0 self-stretch rounded-full",
                  e.severity >= 4 ? "bg-destructive" : "bg-warning",
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold uppercase">{humanise(e.kind)}</span>
                  <span className="text-xs text-muted-foreground">
                    {severityLabel(e.severity)}
                  </span>
                  {overdue && (
                    <span className="text-xs font-medium text-destructive">Overdue</span>
                  )}
                </span>
                <span className="block truncate text-sm text-muted-foreground">
                  {e.reason ?? humanise(e.state)}
                </span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {shortDuration(now - new Date(e.created_at).getTime())}
              </span>
              <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
