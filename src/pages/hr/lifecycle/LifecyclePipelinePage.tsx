/**
 * Lifecycle Pipeline Queue — shared surface for a specific event family
 * (onboarding, probation, transfers, renewals, offboarding).
 *
 * A pipeline is defined by the event_type set it monitors. The queue
 * groups events by employee so operators see the current position of
 * each person, not just a raw log.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { formatDistanceToNow, format } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, ExternalLink, Inbox } from "lucide-react";
import { PageHeader, PageBody } from "@/design-system";
import {
  useLifecycleEvents,
  LIFECYCLE_EVENT_LABELS,
  lifecycleEventTone,
  type LifecycleEvent,
  type LifecycleEventType,
} from "@/hooks/hr/useLifecycleEvents";

interface Props {
  eyebrow: string;
  title: string;
  description: string;
  eventTypes: LifecycleEventType[];
  /** Days back to look. Defaults to 90. */
  sinceDays?: number;
  emptyLabel?: string;
}

interface Group {
  employee_id: string;
  employee_name: string;
  employee_number: string | null;
  latest: LifecycleEvent;
  events: LifecycleEvent[];
}

export function LifecyclePipelinePage({
  eyebrow,
  title,
  description,
  eventTypes,
  sinceDays = 90,
  emptyLabel = "No matching lifecycle activity in this window.",
}: Props) {
  const navigate = useNavigate();
  const { events, isLoading } = useLifecycleEvents({
    eventTypes,
    sinceDays,
    limit: 500,
  });

  const groups = useMemo<Group[]>(() => {
    const byEmp = new Map<string, Group>();
    events.forEach((e) => {
      const g = byEmp.get(e.employee_id);
      if (!g) {
        byEmp.set(e.employee_id, {
          employee_id: e.employee_id,
          employee_name: e.employee_name ?? "Unknown employee",
          employee_number: e.employee_number,
          latest: e,
          events: [e],
        });
      } else {
        g.events.push(e);
        if (new Date(e.occurred_at) > new Date(g.latest.occurred_at)) g.latest = e;
      }
    });
    return Array.from(byEmp.values()).sort(
      (a, b) => new Date(b.latest.occurred_at).getTime() - new Date(a.latest.occurred_at).getTime(),
    );
  }, [events]);

  return (
    <>
      <PageHeader eyebrow={eyebrow} title={title} description={description} />
      <PageBody fullWidth className="gap-4 sm:gap-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : groups.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center space-y-2">
              <Inbox className="h-8 w-8 text-muted-foreground mx-auto" />
              <div className="text-sm font-medium">{emptyLabel}</div>
              <p className="text-xs text-muted-foreground">
                Events show up here as soon as they are recorded on employees.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y">
                {groups.map((g) => (
                  <li key={g.employee_id} className="flex items-start gap-3 p-4 hover:bg-muted/40">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm font-medium truncate">{g.employee_name}</span>
                        {g.employee_number && (
                          <span className="text-xs text-muted-foreground">#{g.employee_number}</span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          · {formatDistanceToNow(new Date(g.latest.occurred_at), { addSuffix: true })}
                          {g.latest.effective_date
                            ? ` · effective ${format(new Date(g.latest.effective_date), "MMM d, yyyy")}`
                            : ""}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <Badge variant={lifecycleEventTone(g.latest.event_type)}>
                          {LIFECYCLE_EVENT_LABELS[g.latest.event_type] ?? g.latest.event_type}
                        </Badge>
                        {g.events.length > 1 && (
                          <span className="text-xs text-muted-foreground">
                            +{g.events.length - 1} earlier
                          </span>
                        )}
                      </div>
                      {g.latest.summary && (
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                          {g.latest.summary}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => navigate(`/hr/employees/${g.employee_id}?section=history`)}
                      title="Open employee"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </PageBody>
    </>
  );
}
