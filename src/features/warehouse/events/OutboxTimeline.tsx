/**
 * <OutboxTimeline aggregateId /> — Phase 4 §1.
 *
 * The single audit surface for a WMS aggregate. Reads `business_event_outbox`
 * filtered by `source_doc_id` and renders the ordered `warehouse.*` topics
 * that the transition RPCs emitted for that row.
 *
 * Why the outbox and not a per-table history: every sanctioned WMS RPC emits
 * onto the outbox via `_wms_emit_outbox` (ADR 0101 §3), so one query gives a
 * complete, tamper-evident lifecycle for ANY aggregate — task, LPN, wave,
 * manifest, QC inspection, count session, receiving session — with no new
 * tables and no per-page bespoke history code.
 *
 * Realtime: the WMS channel invalidates `["wms-outbox-timeline"]` when a
 * warehouse row changes, so the timeline follows the board without polling.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { LoadingState, EmptyState } from "@/design-system";
import { History } from "lucide-react";
import { cn } from "@/lib/utils";

export interface OutboxTimelineProps {
  /** The aggregate row id — matches `business_event_outbox.source_doc_id`. */
  aggregateId: string | null | undefined;
  /** Cap the number of chips rendered. Default 50. */
  limit?: number;
  /** Render compactly (single line per event, no card chrome). */
  compact?: boolean;
  className?: string;
}

interface OutboxRow {
  id: string;
  event_type: string;
  source_doc_type: string | null;
  created_at: string;
  actor_user_id: string | null;
  payload: Record<string, unknown> | null;
}

/** `warehouse.wave.released` → `Wave released`. */
export function topicLabel(topic: string): string {
  const parts = topic.split(".");
  const tail = parts.slice(1);
  if (tail.length === 0) return topic;
  const [aggregate, ...rest] = tail;
  const action = rest.join(" ").replace(/_/g, " ");
  const head = aggregate.replace(/_/g, " ");
  const text = `${head} ${action}`.trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Coarse tone so a failure/cancel reads differently from a happy path. */
export function topicTone(topic: string): "ok" | "warn" | "bad" | "info" {
  if (/(cancelled|voided|failed|no_show|exception|discrepant)/.test(topic)) return "bad";
  if (/(reopened|quarantined|paused|escalated|conditional)/.test(topic)) return "warn";
  if (/(completed|posted|dispatched|shipped|passed|resolved|closed|sealed|stored)/.test(topic))
    return "ok";
  return "info";
}

const TONE_CLASS: Record<ReturnType<typeof topicTone>, string> = {
  ok: "bg-success/10 text-success border-success/30",
  warn: "bg-warning/10 text-warning border-warning/30",
  bad: "bg-destructive/10 text-destructive border-destructive/30",
  info: "bg-muted text-muted-foreground border-border",
};

export function elapsedLabel(iso: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function OutboxTimeline({
  aggregateId,
  limit = 50,
  compact = false,
  className,
}: OutboxTimelineProps) {
  const { data: events = [], isLoading } = useQuery({
    queryKey: ["wms-outbox-timeline", aggregateId, limit],
    enabled: !!aggregateId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("business_event_outbox")
        .select("id, event_type, source_doc_type, created_at, actor_user_id, payload")
        .eq("source_doc_id", aggregateId as string)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as unknown as OutboxRow[];
    },
  });

  if (!aggregateId) return null;
  if (isLoading) return <LoadingState />;
  if (events.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="No events yet"
        description="Lifecycle events appear here as this record moves through the warehouse."
      />
    );
  }

  return (
    <ol className={cn("space-y-2", className)} aria-label="Event timeline">
      {events.map((e, i) => {
        const tone = topicTone(e.event_type);
        return (
          <li
            key={e.id}
            className={cn(
              "flex items-center gap-3 text-xs",
              !compact && "rounded-md border border-border bg-card px-3 py-2",
            )}
          >
            <span className="w-5 shrink-0 text-right font-mono text-muted-foreground">{i + 1}</span>
            <span className={cn("rounded-full border px-2 py-0.5 font-medium", TONE_CLASS[tone])}>
              {topicLabel(e.event_type)}
            </span>
            <span className="text-muted-foreground">{new Date(e.created_at).toLocaleString()}</span>
            <span className="ml-auto text-muted-foreground">{elapsedLabel(e.created_at)}</span>
          </li>
        );
      })}
    </ol>
  );
}

export default OutboxTimeline;
