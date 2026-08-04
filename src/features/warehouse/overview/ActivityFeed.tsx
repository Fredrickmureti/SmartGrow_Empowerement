/**
 * Activity feed — the floor's heartbeat.
 *
 * Renders the `business_event_outbox` stream (via `wms_activity_feed`) so a
 * supervisor can see that work is actually moving, and how fast. Topics come
 * from the WMS event catalog (ADR 0101); this component only formats them.
 */
import { formatDistanceToNowStrict } from "date-fns";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/design-system";
import { humanise } from "@/features/warehouse/control-center/contract";
import type { ActivityEvent } from "./contract";

/** Colour by topic family — receive / move / dispatch / exception. */
function topicTone(eventType: string): string {
  if (eventType.includes("exception") || eventType.includes("failed")) return "bg-destructive";
  if (eventType.includes("receiv") || eventType.includes("putaway")) return "bg-success";
  if (eventType.includes("load") || eventType.includes("dispatch") || eventType.includes("ship"))
    return "bg-primary";
  return "bg-muted-foreground";
}

function label(event: ActivityEvent): string {
  const parts = event.event_type.split(".");
  const tail = parts.slice(-2).join(" ");
  return humanise(tail.replace(/[._]/g, " "));
}

export function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <EmptyState
        title="No activity yet"
        description="Warehouse events appear here the moment work is recorded on the floor."
      />
    );
  }

  return (
    <ol className="relative space-y-3 pl-4">
      <span className="absolute left-[3px] top-1 h-[calc(100%-0.5rem)] w-px bg-border" />
      {events.map((event) => (
        <li key={event.id} className="relative">
          <span
            className={cn(
              "absolute -left-4 top-1.5 h-[7px] w-[7px] rounded-full",
              topicTone(event.event_type),
            )}
          />
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">{label(event)}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatDistanceToNowStrict(new Date(event.created_at), { addSuffix: true })}
            </span>
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {event.source_doc_type ? humanise(event.source_doc_type) : event.event_type}
          </div>
        </li>
      ))}
    </ol>
  );
}

export default ActivityFeed;
