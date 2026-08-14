/**
 * CycleCounts — the cycle-count supervisor command centre (Phase C).
 *
 * A supervisor's questions are operational, not tabular: what is being
 * counted right now, what is stuck waiting on a recount, what needs my
 * approval, which schedules have slipped, how accurate are my counts, who
 * is counting, and which bins keep going wrong. Each of those is answered
 * by a read-only aggregate RPC (`get_count_command_center`,
 * `get_count_session_board`) so tolerance, accuracy and blind masking stay
 * server-authoritative — this page computes no warehouse rule.
 *
 * The session grid is virtualised (TanStack Virtual): a busy warehouse
 * runs hundreds of open sessions and the previous unvirtualised table
 * rendered every row.
 *
 * Every write still lives in Planner / Session / Review through the
 * sanctioned RPCs; nothing here mutates.
 */
import { useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  PageHeader,
  PageBody,
  Section,
  LoadingState,
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MetricTile } from "@/features/warehouse/dashboards/DashboardPrimitives";
import { useWarehouseQtyFormatter } from "@/features/warehouse/quantity/warehouseQty";
import { useProductBaseUomLabels } from "@/features/warehouse/quantity/useProductBaseUomLabels";
import {
  useCountCommandCenter,
  useCountSessionBoard,
  accuracyPct,
  type CountSessionBoardRow,
} from "@/features/warehouse/counts/useCountCommandCenter";
import {
  Plus,
  Zap,
  RefreshCw,
  ShieldCheck,
  CalendarClock,
  Target,
  Activity,
  EyeOff,
} from "lucide-react";

const ROW_HEIGHT = 44;

function stateTone(state: string) {
  if (state === "posted") return "success" as const;
  if (state === "cancelled") return "neutral" as const;
  if (state === "review") return "warning" as const;
  return "info" as const;
}

function sessionHref(s: CountSessionBoardRow) {
  return `/warehouse-app/counts/${s.id}${s.state === "posted" || s.state === "review" ? "/review" : ""}`;
}

/** Accuracy sparkline — plain SVG, no charting dependency. */
function AccuracySparkline({ points }: { points: Array<{ day: string; counted_lines: number; accurate_lines: number }> }) {
  if (points.length < 2) {
    return <p className="text-sm text-muted-foreground">Not enough posted counts yet to trend accuracy.</p>;
  }
  const values = points.map((p) =>
    p.counted_lines ? (p.accurate_lines / p.counted_lines) * 100 : 0,
  );
  const w = 100;
  const h = 30;
  const step = w / (values.length - 1);
  const path = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(2)},${(h - (v / 100) * h).toFixed(2)}`)
    .join(" ");
  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full" preserveAspectRatio="none" role="img" aria-label="Counting accuracy over the last 30 days">
        <path d={path} fill="none" stroke="currentColor" strokeWidth={1} className="text-primary" vectorEffect="non-scaling-stroke" />
      </svg>
      <p className="text-xs text-muted-foreground">
        {points[0].day} → {points[points.length - 1].day} · daily line accuracy on posted sessions
      </p>
    </div>
  );
}

export default function CycleCounts() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const board = useCountSessionBoard(businessId);
  const centre = useCountCommandCenter(businessId);

  const sessions = board.data ?? [];
  const c = centre.data;

  // Phase 2.4 — variance figures carry the counted product's unit vocabulary.
  const activityProductIds = useMemo(
    () => (c?.activity ?? []).map((a) => a.product_id),
    [c?.activity],
  );
  const activityBaseLabels = useProductBaseUomLabels(activityProductIds);
  const qtyFmt = useWarehouseQtyFormatter(activityProductIds, activityBaseLabels);

  const recountQueue = useMemo(
    () => sessions.filter((s) => s.open_recounts > 0 && s.state !== "posted" && s.state !== "cancelled"),
    [sessions],
  );
  const approvalQueue = useMemo(
    () => sessions.filter((s) => s.state === "review" && s.requires_approval),
    [sessions],
  );
  const blockedByReason = useMemo(
    () => sessions.filter((s) => s.unexplained_variances > 0 && s.state !== "posted" && s.state !== "cancelled"),
    [sessions],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: sessions.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const accuracy = c ? accuracyPct(c.accuracy_counted_lines, c.accuracy_accurate_lines) : null;
  const loading = board.isLoading || centre.isLoading;

  return (
    <>
      <PageHeader
        title="Cycle count command centre"
        description="Live counting operations. Variances post through the inventory adjustment RPC — Warehouse never edits stock directly."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/warehouse-app/counts/automation"><Zap className="mr-2 h-4 w-4" /> Automation</Link>
            </Button>
            <Button asChild>
              <Link to="/warehouse-app/counts/new"><Plus className="mr-2 h-4 w-4" /> New session</Link>
            </Button>
          </div>
        }
      />
      <PageBody>
        <p className="-mt-2 text-sm text-muted-foreground">
          Adjustments from completed sessions are posted by Inventory —{" "}
          <Link className="underline" to="/inventory-app/physical-counts">open the inventory count workspace</Link>.
        </p>

        {loading ? (
          <LoadingState />
        ) : (
          <>
            <Section>
              <div className="min-w-0 grid gap-3 @xl/page:grid-cols-2 @4xl/page:grid-cols-3 @5xl/page:grid-cols-6">
                <MetricTile label="Counting now" value={c?.in_progress ?? 0} icon={Activity} />
                <MetricTile
                  label="Open recounts"
                  value={c?.open_recounts ?? 0}
                  tone={(c?.open_recounts ?? 0) > 0 ? "bad" : "ok"}
                  sub="submission blocked"
                  icon={RefreshCw}
                />
                <MetricTile
                  label="Awaiting approval"
                  value={c?.awaiting_approval ?? 0}
                  tone={(c?.awaiting_approval ?? 0) > 0 ? "warn" : "ok"}
                  icon={ShieldCheck}
                />
                <MetricTile
                  label="Missing reason codes"
                  value={blockedByReason.length}
                  tone={blockedByReason.length > 0 ? "warn" : "ok"}
                  sub="variance unexplained"
                  icon={Target}
                />
                <MetricTile
                  label="Overdue schedules"
                  value={c?.overdue_schedules.length ?? 0}
                  tone={(c?.overdue_schedules.length ?? 0) > 0 ? "warn" : "ok"}
                  icon={CalendarClock}
                  to="/warehouse-app/counts/automation"
                />
                <MetricTile
                  label="Accuracy (30d)"
                  value={accuracy === null ? "—" : `${accuracy}%`}
                  sub={`${c?.accuracy_counted_lines ?? 0} posted lines`}
                  tone={accuracy === null ? "neutral" : accuracy >= 98 ? "ok" : accuracy >= 95 ? "warn" : "bad"}
                  icon={Target}
                />
              </div>
            </Section>

            <div className="min-w-0 grid gap-4 @4xl/page:grid-cols-3">
              <Section
                title="Recount queue"
                description="Lines outside tolerance with no newer attempt. These sessions cannot be submitted."
                className="min-w-0 @4xl/page:col-span-1"
              >
                <div className="space-y-2">
                  {recountQueue.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No open recounts.</p>
                  ) : (
                    recountQueue.map((s) => (
                      <Link
                        key={s.id}
                        to={sessionHref(s)}
                        className="flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm hover:border-destructive"
                      >
                        <span className="font-mono">{s.code}</span>
                        <span className="text-destructive">
                          {s.open_recounts} line{s.open_recounts === 1 ? "" : "s"}
                        </span>
                      </Link>
                    ))
                  )}
                </div>
              </Section>

              <Section
                title="Approval queue"
                description="Sessions in review that need a supervisor other than the counter."
                className="min-w-0 @4xl/page:col-span-1"
              >
                <div className="space-y-2">
                  {approvalQueue.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Nothing waiting on approval.</p>
                  ) : (
                    approvalQueue.map((s) => (
                      <Link
                        key={s.id}
                        to={sessionHref(s)}
                        className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:border-primary"
                      >
                        <span className="font-mono">{s.code}</span>
                        <span className="text-muted-foreground">
                          {s.variance_lines === null ? "blind" : `${s.variance_lines} variance`}
                        </span>
                      </Link>
                    ))
                  )}
                </div>
              </Section>

              <Section title="Counting accuracy" description="Posted lines, last 30 days." className="min-w-0 @4xl/page:col-span-1">
                <AccuracySparkline points={c?.accuracy_trend ?? []} />
              </Section>
            </div>

            <Section
              title="Sessions"
              description="Most recent first. Expected and variance figures stay hidden while a blind session is being counted."
             contentClassName="px-0 pb-0">
              <div className="grid grid-cols-[8rem_7rem_6rem_1fr_7rem_7rem_6rem] gap-2 border-b bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">
                <span>Code</span>
                <span>Strategy</span>
                <span>State</span>
                <span>Progress</span>
                <span className="text-right">Variance</span>
                <span className="text-right">Recounts</span>
                <span />
              </div>
              {sessions.length === 0 ? (
                <p className="p-4 text-center text-sm text-muted-foreground">No sessions yet.</p>
              ) : (
                <div ref={scrollRef} className="max-h-[28rem] overflow-auto">
                  <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                    {virtualizer.getVirtualItems().map((v) => {
                      const s = sessions[v.index];
                      const pct = s.line_count
                        ? Math.round((s.counted_count / s.line_count) * 100)
                        : 0;
                      return (
                        <div
                          key={s.id}
                          className="absolute left-0 top-0 grid w-full grid-cols-[8rem_7rem_6rem_1fr_7rem_7rem_6rem] items-center gap-2 border-b px-3 text-sm"
                          style={{ height: v.size, transform: `translateY(${v.start}px)` }}
                        >
                          <span className="flex items-center gap-1 truncate font-mono">
                            {s.code}
                            {s.is_blind ? <EyeOff className="h-3 w-3 text-muted-foreground" aria-label="Blind" /> : null}
                          </span>
                          <span className="truncate capitalize">{s.strategy?.replace(/_/g, " ")}</span>
                          <span>
                            <StatusBadge tone={stateTone(s.state)}>{s.state}</StatusBadge>
                          </span>
                          <span className="flex items-center gap-2">
                            <span className="h-2 w-full max-w-32 overflow-hidden rounded-full bg-muted">
                              <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                            </span>
                            <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                              {s.counted_count}/{s.line_count}
                            </span>
                          </span>
                          <span className="text-right tabular-nums">
                            {s.variance_lines === null ? (
                              <span className="text-muted-foreground">hidden</span>
                            ) : (
                              s.variance_lines
                            )}
                          </span>
                          <span className="text-right tabular-nums">
                            {s.open_recounts > 0 ? (
                              <span className="text-destructive">{s.open_recounts}</span>
                            ) : (
                              <span className="text-muted-foreground">{s.open_recounts}</span>
                            )}
                          </span>
                          <span className="text-right">
                            <Button size="sm" variant="outline" asChild>
                              <Link to={sessionHref(s)}>Open</Link>
                            </Button>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </Section>

            <div className="min-w-0 grid gap-4 @4xl/page:grid-cols-2">
              <Section title="Counter productivity today" description="Lines counted since midnight." contentClassName="px-0 pb-0">
                {(c?.operator_productivity.length ?? 0) === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">Nothing counted yet today.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Counter</TableHead>
                        <TableHead className="text-right">Lines</TableHead>
                        <TableHead className="text-right">Variances</TableHead>
                        <TableHead className="text-right">Flagged</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(c?.operator_productivity ?? []).map((o) => (
                        <TableRow key={o.user_id}>
                          <TableCell className="font-mono text-xs">{o.user_id.slice(0, 8)}</TableCell>
                          <TableCell className="text-right font-mono">{o.lines_counted}</TableCell>
                          <TableCell className="text-right font-mono">{o.variance_lines}</TableCell>
                          <TableCell className="text-right font-mono">{o.flagged_lines}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </Section>

              <Section title="Problem bins" description="Bins with the most variance lines over the last 90 days of posted counts.">
                <div className="space-y-2">
                  {(c?.bin_heatmap.length ?? 0) === 0 ? (
                    <p className="text-sm text-muted-foreground">No posted variances in the last 90 days.</p>
                  ) : (
                    (c?.bin_heatmap ?? []).map((b) => {
                      const worst = c?.bin_heatmap[0]?.variance_lines || 1;
                      const share = Math.max(4, (b.variance_lines / worst) * 100);
                      return (
                        <div key={b.location_id ?? b.location_code ?? "unknown"} className="flex items-center gap-3 text-sm">
                          <span className="w-32 shrink-0 truncate font-mono text-xs">
                            {b.location_code ?? "—"}
                          </span>
                          <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                            <span className="block h-full rounded-full bg-destructive" style={{ width: `${share}%` }} />
                          </span>
                          <span className="w-24 shrink-0 text-right tabular-nums text-xs text-muted-foreground">
                            {b.variance_lines}/{b.counted_lines} lines
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              </Section>
            </div>

            <Section title="Activity feed" description="The last 40 recorded count lines across every session." contentClassName="px-0 pb-0">
              {(c?.activity.length ?? 0) === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">No counting activity yet.</p>
              ) : (
                <ul className="divide-y">
                  {(c?.activity ?? []).map((a) => (
                    <li key={a.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                      <span className="w-36 shrink-0 text-xs text-muted-foreground">
                        {new Date(a.counted_at).toLocaleString()}
                      </span>
                      <Link to={`/warehouse-app/counts/${a.session_id}`} className="w-24 shrink-0 truncate font-mono text-xs underline">
                        {a.session_code ?? "—"}
                      </Link>
                      <span className="w-24 shrink-0 truncate font-mono text-xs">{a.location_code ?? "—"}</span>
                      <span className="flex-1 truncate">{a.product_name ?? "—"}</span>
                      {a.recount_round && a.recount_round > 1 ? (
                        <StatusBadge tone="warning">round {a.recount_round}</StatusBadge>
                      ) : null}
                      {a.tolerance_outcome === "recount_required" ? (
                        <StatusBadge tone="danger">recount</StatusBadge>
                      ) : null}
                      <span className="w-20 shrink-0 text-right tabular-nums">
                        {a.variance_qty === null ? (
                          <span className="text-muted-foreground">hidden</span>
                        ) : Number(a.variance_qty) === 0 ? (
                          <span className="text-muted-foreground">
                            {qtyFmt.format(a.product_id, 0)}
                          </span>
                        ) : (
                          <span className="text-destructive">
                            {qtyFmt.formatSigned(a.product_id, a.variance_qty)}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </PageBody>
    </>
  );
}
