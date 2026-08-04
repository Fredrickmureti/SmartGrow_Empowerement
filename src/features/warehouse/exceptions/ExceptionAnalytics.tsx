/**
 * <ExceptionAnalytics /> — Phase 6 of the Exceptions command centre.
 *
 * Turns the inbox from a queue into a management instrument: recurrence by
 * kind, root-cause mix, class exposure, SLA compliance and ageing. Everything
 * is derived client-side from a bounded 90-day window of `wms_exceptions`, so
 * no extra reporting objects are needed in the database.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { LoadingState, EmptyState, StatusBadge } from "@/design-system";
import { BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ExceptionClass, ExceptionState, CLASS_TONE, humanise, shortDuration,
  TERMINAL_STATES,
} from "./constants";

interface AnalyticsRow {
  kind: string;
  class: ExceptionClass | null;
  state: ExceptionState;
  severity: number;
  resolution_kind: string | null;
  due_by: string | null;
  created_at: string;
  resolved_at: string | null;
  sla_breached_at: string | null;
  financial_impact: number | null;
}

export function ExceptionAnalytics({ warehouseId }: { warehouseId: string }) {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["wms_exception_analytics", warehouseId],
    enabled: !!warehouseId,
    queryFn: async () => {
      const since = new Date(Date.now() - 90 * 86400000).toISOString();
      const { data, error } = await supabase
        .from("wms_exceptions" as any)
        .select("kind, class, state, severity, resolution_kind, due_by, created_at, resolved_at, sla_breached_at, financial_impact")
        .eq("warehouse_id", warehouseId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as unknown as AnalyticsRow[];
    },
  });

  const stats = useMemo(() => {
    const closed = rows.filter((r) => TERMINAL_STATES.includes(r.state) && r.resolved_at);
    const resolveMs = closed.map((r) => new Date(r.resolved_at!).getTime() - new Date(r.created_at).getTime());
    const mttr = resolveMs.length ? resolveMs.reduce((a, b) => a + b, 0) / resolveMs.length : 0;
    const breached = rows.filter(
      (r) => r.sla_breached_at || (r.due_by && !TERMINAL_STATES.includes(r.state) && new Date(r.due_by).getTime() < Date.now()),
    ).length;
    const impact = rows.reduce((a, r) => a + Number(r.financial_impact ?? 0), 0);

    const tally = (key: (r: AnalyticsRow) => string | null) => {
      const m = new Map<string, number>();
      rows.forEach((r) => {
        const k = key(r);
        if (!k) return;
        m.set(k, (m.get(k) ?? 0) + 1);
      });
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };

    const open = rows.filter((r) => !TERMINAL_STATES.includes(r.state));
    const buckets = [
      { label: "< 24h", n: 0 }, { label: "1–3d", n: 0 },
      { label: "3–7d", n: 0 }, { label: "> 7d", n: 0 },
    ];
    open.forEach((r) => {
      const days = (Date.now() - new Date(r.created_at).getTime()) / 86400000;
      if (days < 1) buckets[0].n++;
      else if (days < 3) buckets[1].n++;
      else if (days < 7) buckets[2].n++;
      else buckets[3].n++;
    });

    return {
      total: rows.length,
      openCount: open.length,
      mttr,
      slaCompliance: rows.length ? Math.round(((rows.length - breached) / rows.length) * 100) : 100,
      breached,
      impact,
      byKind: tally((r) => r.kind).slice(0, 10),
      byCause: tally((r) => r.resolution_kind).slice(0, 8),
      byClass: tally((r) => r.class) as [ExceptionClass, number][],
      buckets,
    };
  }, [rows]);

  if (isLoading) return <LoadingState />;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No exception history yet"
        description="Analytics appear once exceptions have been raised in the last 90 days."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="min-w-0 grid grid-cols-2 gap-3 @2xl/page:grid-cols-5">
        <Kpi label="Raised (90d)" value={String(stats.total)} />
        <Kpi label="Still open" value={String(stats.openCount)} />
        <Kpi label="Mean time to resolve" value={stats.mttr ? shortDuration(stats.mttr) : "—"} />
        <Kpi
          label="SLA compliance"
          value={`${stats.slaCompliance}%`}
          tone={stats.slaCompliance < 90 ? "danger" : undefined}
        />
        <Kpi
          label="Financial exposure"
          value={stats.impact ? stats.impact.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"}
        />
      </div>

      <div className="min-w-0 grid gap-6 @4xl/page:grid-cols-2">
        <Panel title="Recurring exception kinds" subtitle="Highest-frequency failures — fix the process, not the row.">
          <Bars data={stats.byKind} />
        </Panel>
        <Panel title="Root causes" subtitle="From the mandatory cause code captured at close-out.">
          {stats.byCause.length === 0
            ? <p className="text-sm text-muted-foreground">No exceptions closed with a cause code yet.</p>
            : <Bars data={stats.byCause} />}
        </Panel>
        <Panel title="Class exposure" subtitle="Where the risk sits across quality, safety, compliance and finance.">
          <div className="flex flex-wrap gap-2">
            {stats.byClass.map(([c, n]) => (
              <StatusBadge key={c} tone={CLASS_TONE[c] ?? "neutral"}>
                {humanise(c)} · {n}
              </StatusBadge>
            ))}
          </div>
        </Panel>
        <Panel title="Ageing of open exceptions" subtitle="Anything beyond three days is an escalation failure.">
          <Bars data={stats.buckets.map((b) => [b.label, b.n] as [string, number])} />
        </Panel>
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("text-2xl font-semibold", tone === "danger" && "text-destructive")}>{value}</div>
    </div>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="mb-3">
        <div className="font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      </div>
      {children}
    </div>
  );
}

function Bars({ data }: { data: [string, number][] }) {
  const max = Math.max(1, ...data.map(([, n]) => n));
  if (data.length === 0) return <p className="text-sm text-muted-foreground">No data.</p>;
  return (
    <ul className="space-y-2">
      {data.map(([label, n]) => (
        <li key={label} className="text-xs">
          <div className="mb-1 flex justify-between gap-2">
            <span className="truncate">{humanise(label)}</span>
            <span className="font-medium">{n}</span>
          </div>
          <div className="h-2 rounded-full bg-muted">
            <div className="h-2 rounded-full bg-primary" style={{ width: `${(n / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
