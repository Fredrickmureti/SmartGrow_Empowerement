/**
 * PayrollRunLifecycleTimeline (plan §Phase 5e).
 *
 * Renders `business_event_outbox` rows scoped to the six parallel workflows
 * of a payroll run's period. Sibling to `PayslipEventsTimeline` but for the
 * run itself. Append-only. Country-agnostic — event names are canonical.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, CheckCircle2, Send, Banknote, FileText, Layers, RotateCcw, Lock } from "lucide-react";

const EVENT_PREFIXES = [
  "payroll_posting.",
  "payroll_payment.",
  "payroll_bank_file.",
  "payroll_return.",
  "payroll_remittance.",
  "payroll_period.",
  "payroll_run.",
];

interface EventRow {
  id: string;
  event_type: string;
  created_at: string;
  source_doc_id: string | null;
  payload: Record<string, unknown> | null;
}

function iconFor(evt: string) {
  if (evt.startsWith("payroll_posting")) return Send;
  if (evt.startsWith("payroll_payment")) return Banknote;
  if (evt.startsWith("payroll_bank_file")) return Layers;
  if (evt.startsWith("payroll_return")) return FileText;
  if (evt.startsWith("payroll_remittance")) return RotateCcw;
  if (evt.startsWith("payroll_period")) return Lock;
  return CheckCircle2;
}

function fmtWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

export function PayrollRunLifecycleTimeline({ runId }: { runId: string | null | undefined }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["payroll", "workflow", "lifecycle", runId],
    enabled: !!runId,
    queryFn: async (): Promise<EventRow[]> => {
      const or = EVENT_PREFIXES.map((p) => `event_type.like.${p}%`).join(",");
      const { data, error } = await supabase
        .from("business_event_outbox")
        .select("id,event_type,created_at,source_doc_id,payload")
        .eq("source_doc_id", runId!)
        .or(or)
        .order("created_at", { ascending: true })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as EventRow[];
    },
  });

  if (!runId) return null;
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading lifecycle…
      </div>
    );
  }
  if (error) {
    return <div className="text-sm text-destructive py-2">Failed to load lifecycle events.</div>;
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-6 border rounded-md text-center">
        No lifecycle events yet. Events appear as each parallel workflow advances.
      </div>
    );
  }

  return (
    <ol className="relative border-l border-border ml-3 space-y-4 py-2">
      {rows.map((e) => {
        const Icon = iconFor(e.event_type);
        return (
          <li key={e.id} className="ml-4">
            <span className="absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full bg-background border border-border">
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
            <div className="text-sm font-medium">{e.event_type}</div>
            <div className="text-xs text-muted-foreground">{fmtWhen(e.created_at)}</div>
          </li>
        );
      })}
    </ol>
  );
}