/**
 * PrintLatency — the read side of the printing tracer.
 *
 * `withTrace` / `withSpan` write one row per cashier action into
 * `print_traces`; this page turns those rows into a waterfall so an operator
 * can answer "where did the time go?" without a database client. RLS scopes
 * the table to the creating user, so this view shows *your* prints.
 *
 * Read-only by construction: nothing here mutates print state.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, RefreshCw, AlertTriangle, Timer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

interface TraceSpanRow {
  name: string;
  startOffsetMs: number;
  durationMs: number;
  ok: boolean;
  error?: string;
  attributes?: Record<string, string | number | boolean | null>;
}

interface TraceRow {
  id: string;
  correlation_id: string;
  label: string;
  total_ms: number;
  spans: TraceSpanRow[];
  attributes: Record<string, string | number | boolean | null>;
  created_at: string;
}

/** Colour band by cost, so the expensive stage is obvious at a glance. */
function bandFor(ms: number, total: number): string {
  const share = total > 0 ? ms / total : 0;
  if (share >= 0.5) return "bg-destructive";
  if (share >= 0.2) return "bg-amber-500";
  return "bg-primary";
}

function pct(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0.5, Math.min(100, (value / total) * 100));
}

function Waterfall({ trace }: { trace: TraceRow }) {
  const spans = [...(trace.spans ?? [])].sort((a, b) => a.startOffsetMs - b.startOffsetMs);
  const total = Math.max(trace.total_ms, ...spans.map((s) => s.startOffsetMs + s.durationMs), 1);

  if (spans.length === 0) {
    return <p className="text-sm text-muted-foreground">No spans recorded for this trace.</p>;
  }

  return (
    <div className="space-y-1">
      {spans.map((span, i) => (
        <div key={`${span.name}-${i}`} className="grid grid-cols-[minmax(9rem,14rem)_1fr_4.5rem] items-center gap-2">
          <span className="truncate font-mono text-xs" title={span.name}>
            {span.name}
          </span>
          <div className="relative h-4 rounded bg-muted">
            <div
              className={cn(
                "absolute inset-y-0 rounded",
                span.ok ? bandFor(span.durationMs, total) : "bg-destructive",
              )}
              style={{
                left: `${pct(span.startOffsetMs, total)}%`,
                width: `${pct(span.durationMs, total)}%`,
              }}
              title={span.error ?? `${span.durationMs}ms`}
            />
          </div>
          <span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
            {Math.round(span.durationMs)}ms
          </span>
        </div>
      ))}
    </div>
  );
}

export default function PrintLatency() {
  const [selected, setSelected] = useState<string | null>(null);

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ["print-latency-traces"],
    queryFn: async (): Promise<TraceRow[]> => {
      const { data, error } = await supabase
        .from("print_traces" as never)
        .select("id, correlation_id, label, total_ms, spans, attributes, created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return ((data ?? []) as unknown as TraceRow[]).map((row) => ({
        ...row,
        spans: Array.isArray(row.spans) ? row.spans : [],
        attributes: row.attributes ?? {},
      }));
    },
  });

  const traces = data ?? [];
  const active = useMemo(
    () => traces.find((t) => t.id === selected) ?? traces[0] ?? null,
    [traces, selected],
  );

  const stageTotals = useMemo(() => {
    const totals = new Map<string, { ms: number; n: number }>();
    for (const trace of traces) {
      for (const span of trace.spans ?? []) {
        const prev = totals.get(span.name) ?? { ms: 0, n: 0 };
        totals.set(span.name, { ms: prev.ms + span.durationMs, n: prev.n + 1 });
      }
    }
    return [...totals.entries()]
      .map(([name, v]) => ({ name, avg: v.ms / Math.max(v.n, 1), n: v.n }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 8);
  }, [traces]);

  return (
    <div className="container mx-auto space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Print latency</h1>
          <p className="text-sm text-muted-foreground">
            End-to-end waterfalls for your recent print jobs, recorded by the printing tracer.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isRefetching}>
          <RefreshCw className={cn("mr-2 h-4 w-4", isRefetching && "animate-spin")} />
          Refresh
        </Button>
      </header>

      {error ? (
        <Card>
          <CardContent className="flex items-center gap-2 p-6 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {(error as Error).message}
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading traces…
        </div>
      ) : traces.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No traces yet</CardTitle>
            <CardDescription>
              Print a receipt, invoice or label and the waterfall will appear here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Recent prints</CardTitle>
              <CardDescription>{traces.length} traces</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[28rem]">
                <ul className="divide-y">
                  {traces.map((trace) => (
                    <li key={trace.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(trace.id)}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm hover:bg-muted/60",
                          active?.id === trace.id && "bg-muted",
                        )}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{trace.label}</span>
                          <span className="block text-xs text-muted-foreground">
                            {new Date(trace.created_at).toLocaleTimeString()}
                          </span>
                        </span>
                        <Badge variant={trace.total_ms > 2000 ? "destructive" : "secondary"}>
                          {Math.round(trace.total_ms)}ms
                        </Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </CardContent>
          </Card>

          <div className="space-y-6">
            {active && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Timer className="h-4 w-4" />
                    {active.label}
                    <Badge variant="secondary">{Math.round(active.total_ms)}ms total</Badge>
                  </CardTitle>
                  <CardDescription className="font-mono text-xs">
                    {active.correlation_id}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Waterfall trace={active} />
                  {Object.keys(active.attributes ?? {}).length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-2">
                      {Object.entries(active.attributes).map(([k, v]) => (
                        <Badge key={k} variant="outline" className="font-mono text-[11px]">
                          {k}={String(v)}
                        </Badge>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Slowest stages (average)</CardTitle>
                <CardDescription>Across the traces loaded above</CardDescription>
              </CardHeader>
              <CardContent className="space-y-1">
                {stageTotals.map((stage) => (
                  <div
                    key={stage.name}
                    className="grid grid-cols-[minmax(9rem,14rem)_1fr_6rem] items-center gap-2"
                  >
                    <span className="truncate font-mono text-xs">{stage.name}</span>
                    <div className="h-3 rounded bg-muted">
                      <div
                        className="h-3 rounded bg-primary"
                        style={{ width: `${pct(stage.avg, stageTotals[0]?.avg ?? 1)}%` }}
                      />
                    </div>
                    <span className="text-right font-mono text-xs text-muted-foreground">
                      {Math.round(stage.avg)}ms ×{stage.n}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
