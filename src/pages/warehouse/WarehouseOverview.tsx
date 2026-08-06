/**
 * Warehouse Overview — the operational home page of the Warehouse app.
 *
 * ADR 0102 (one command centre) + ADR 0103 (dashboard composition is a
 * design-system concern). This page declares *composition only*: bands,
 * widgets and semantic spans. It authors no grid geometry, no card chrome
 * and no page-level loading gate — `DashboardWidget` owns each panel's
 * loading / empty / error lifecycle so one slow RPC cannot blank the board.
 *
 * Reading order matches how a supervisor triages a shift:
 *
 *   Status    — is the warehouse healthy, and the six numbers that prove it.
 *   Act now   — ranked blockers + open exceptions.
 *   Flow      — stage spine, then the risk-ordered work it filters.
 *   Towers    — inbound and outbound headline, handing off to their tower.
 *   Readiness — capacity, labour, equipment, zones.
 *   Activity  — the event fabric proving work is actually moving.
 *
 * Every number is aggregated in SQL by the module that owns it. This page
 * fetches, composes and links; it computes nothing.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { PageHeader, PageBody } from "@/design-system";
import {
  DashboardCanvas,
  DashboardBand,
  DashboardWidget,
  HeroStatus,
  KpiRibbon,
  PriorityPanel,
  type DashboardTone,
  type PriorityItem as DsPriorityItem,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  BottleneckRail, FlowSpine, LabourPanel, LiveWorkPanel, ZoneLoadPanel,
  useFlowBottlenecks, useFlowHealth, useZoneLoad, humanise, severityTone,
  HEALTH_LABEL, type HealthState,
} from "@/features/warehouse/control-center";
import { useInboundBottlenecks, useInboundHealth } from "@/features/warehouse/inbound-tower";
import { useOutboundBottlenecks, useOutboundHealth } from "@/features/warehouse/outbound-tower";
import {
  ActivityFeed, CapacityPanel, EquipmentPanel, TowerSummaryCard,
  rankPriorities, useActivityFeed, useEquipmentHealth, useOverviewCapacity,
  useOverviewExceptions,
} from "@/features/warehouse/overview";

/** Which task types belong to a stage, for the flow-spine → work-list drill. */
const STAGE_TASK_TYPES: Record<string, readonly string[]> = {
  receive: ["putaway"],
  inspect: ["qc"],
  putaway: ["putaway"],
  replenish: ["replenish"],
  pick: ["pick"],
  pack: ["pack"],
  load: ["load"],
  dispatch: ["load"],
  store: ["count", "move"],
};

/** Health state → the design-system tone vocabulary. */
const HEALTH_TONE: Record<HealthState, DashboardTone> = {
  healthy: "success",
  degraded: "warning",
  critical: "danger",
  blocked: "danger",
};

export default function WarehouseOverview() {
  const health = useFlowHealth();
  const flowBottlenecks = useFlowBottlenecks();
  const inboundHealth = useInboundHealth();
  const outboundHealth = useOutboundHealth();
  const inboundBottlenecks = useInboundBottlenecks();
  const outboundBottlenecks = useOutboundBottlenecks();
  const zones = useZoneLoad();
  const capacity = useOverviewCapacity();
  const equipment = useEquipmentHealth();
  const activity = useActivityFeed();
  const exceptions = useOverviewExceptions();

  const [stage, setStage] = useState<string | null>(null);

  const queries = [
    health, flowBottlenecks, inboundHealth, outboundHealth, inboundBottlenecks,
    outboundBottlenecks, zones, capacity, equipment, activity, exceptions,
  ];
  const refreshing = queries.some((q) => q.isFetching);
  const refresh = () => queries.forEach((q) => q.refetch());

  const priorities = useMemo(
    () =>
      rankPriorities({
        flow: flowBottlenecks.data,
        inbound: inboundBottlenecks.data,
        outbound: outboundBottlenecks.data,
      }),
    [flowBottlenecks.data, inboundBottlenecks.data, outboundBottlenecks.data],
  );

  const priorityItems: DsPriorityItem[] = useMemo(
    () =>
      priorities.map((p) => ({
        id: p.key,
        title: p.reason,
        detail: `${humanise(p.origin)} · ${humanise(p.scope)}`,
        impact: p.impact_count > 0 ? p.impact_count : undefined,
        tone: HEALTH_TONE[severityTone(p.severity)],
        severityLabel: HEALTH_LABEL[severityTone(p.severity)],
        to: p.route,
      })),
    [priorities],
  );

  const stageTaskTypes = useMemo(
    () => (stage ? STAGE_TASK_TYPES[stage] ?? null : null),
    [stage],
  );

  const stages = health.data?.stages ?? [];
  const activeStageLabel = stages.find((s) => s.stage === stage)?.label;
  const openExceptions = exceptions.data ?? [];

  const totals = useMemo(() => {
    const sum = (pick: (s: (typeof stages)[number]) => number) =>
      stages.reduce((acc, s) => acc + (pick(s) || 0), 0);
    return {
      openWork: sum((s) => s.backlog) + sum((s) => s.in_progress),
      unassigned: sum((s) => s.unassigned),
      atRisk: sum((s) => s.sla_at_risk),
      breached: sum((s) => s.sla_breached),
      blocked: sum((s) => s.blocked),
    };
  }, [stages]);

  const kpiLoading = health.isLoading;

  return (
    <>
      <PageHeader
        title="Warehouse overview"
        description="One command centre: live health, priorities, flow, capacity, labour and equipment."
        actions={
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
            <RefreshCw className={cn("mr-2 h-4 w-4", refreshing && "animate-spin")} />
            Refresh
          </Button>
        }
      />
      <PageBody>
        <DashboardCanvas label="Warehouse command centre" density="compact">
          {/* ── Status ───────────────────────────────────────────────── */}
          <DashboardBand title="Status" hideLabel>
            <DashboardWidget span="full" variant="plain" className="border-0 shadow-none" contentClassName="p-0">
              <div className="space-y-[var(--ds-dashboard-gap)]">
                <HeroStatus
                  state={
                    health.isLoading
                      ? "Reading the floor…"
                      : HEALTH_LABEL[health.data?.overall ?? "healthy"]
                  }
                  tone={HEALTH_TONE[health.data?.overall ?? "healthy"]}
                  reason={health.isError
                    ? (health.error as Error)?.message
                    : health.data?.reason}
                  detail={
                    health.data?.worst_stage
                      ? `Worst stage: ${humanise(health.data.worst_stage)}`
                      : undefined
                  }
                  actions={
                    <Button asChild size="sm" variant="outline">
                      <Link to="/warehouse-app/exceptions">Exception inbox</Link>
                    </Button>
                  }
                />
                <KpiRibbon
                  label="Warehouse key metrics"
                  items={[
                    { label: "Open work", value: totals.openWork, loading: kpiLoading },
                    {
                      label: "Unassigned", value: totals.unassigned, loading: kpiLoading,
                      tone: totals.unassigned > 0 ? "warning" : "neutral",
                    },
                    {
                      label: "SLA at risk", value: totals.atRisk, loading: kpiLoading,
                      tone: totals.atRisk > 0 ? "warning" : "success",
                    },
                    {
                      label: "SLA breached", value: totals.breached, loading: kpiLoading,
                      tone: totals.breached > 0 ? "danger" : "success",
                    },
                    {
                      label: "Blocked", value: totals.blocked, loading: kpiLoading,
                      tone: totals.blocked > 0 ? "danger" : "success",
                    },
                    {
                      label: "Exceptions", value: openExceptions.length,
                      loading: exceptions.isLoading,
                      tone: openExceptions.length > 0 ? "warning" : "success",
                      to: "/warehouse-app/exceptions",
                    },
                  ]}
                />
              </div>
            </DashboardWidget>
          </DashboardBand>

          {/* ── Act now ──────────────────────────────────────────────── */}
          <DashboardBand
            title="Act now"
            description="Every blocker across flow, inbound and outbound, ranked by severity and impact."
          >
            <DashboardWidget
              span="two-thirds"
              variant="action"
              title="Priorities"
              description="Ranked merge of the flow, inbound and outbound bottleneck feeds."
              query={flowBottlenecks}
              isEmpty={priorityItems.length === 0}
              emptyTitle="Nothing is blocked"
              emptyDescription="No bottleneck is currently reported by any feed."
            >
              <PriorityPanel items={priorityItems} />
            </DashboardWidget>

            <DashboardWidget
              span="third"
              variant="list"
              title="Exceptions"
              description="Open blockers awaiting triage."
              drillTo="/warehouse-app/exceptions"
              drillLabel="Inbox"
              query={exceptions}
              isEmpty={openExceptions.length === 0}
              emptyTitle="No open exceptions"
              emptyDescription="Nothing is currently blocked awaiting a decision."
            >
              <ul className="divide-y">
                {openExceptions.map((e) => (
                  <li key={e.id}>
                    <Link
                      to="/warehouse-app/exceptions"
                      className="flex items-start gap-2 rounded-[var(--ds-radius-sm)] px-1 py-2 text-sm transition-colors hover:bg-muted/50"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{humanise(e.kind)}</div>
                        <div className="truncate text-[length:var(--ds-text-micro)] text-muted-foreground">
                          {e.reason ?? humanise(e.state)}
                        </div>
                      </div>
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {humanise(e.state)}
                      </Badge>
                    </Link>
                  ))}
                </li>
              </ul>
            </DashboardWidget>
          </DashboardBand>

          {/* ── Flow ─────────────────────────────────────────────────── */}
          <DashboardBand
            title="Flow"
            description="Receive → dispatch. Select a stage to filter the work list."
          >
            <DashboardWidget span="full" variant="flow" query={health}>
              <FlowSpine
                stages={stages}
                activeStage={stage}
                onSelect={(s) => setStage((cur) => (cur === s.stage ? null : s.stage))}
              />
            </DashboardWidget>

            <DashboardWidget
              span="full"
              variant="list"
              title={activeStageLabel ? `Live work — ${activeStageLabel}` : "Live work"}
              description="Risk-ordered open work. Assign, return to pool or escalate in place."
              actions={
                stage && (
                  <Button variant="ghost" size="sm" onClick={() => setStage(null)}>
                    Clear filter
                  </Button>
                )
              }
            >
              <LiveWorkPanel taskTypes={stageTaskTypes} />
            </DashboardWidget>

            <DashboardWidget
              span="full"
              variant="list"
              title="All bottlenecks"
              description="Full ranked list from the flow spine, each linked to the surface that clears it."
              query={flowBottlenecks}
              isEmpty={(flowBottlenecks.data ?? []).length === 0}
              emptyTitle="No bottlenecks"
            >
              <BottleneckRail bottlenecks={flowBottlenecks.data ?? []} />
            </DashboardWidget>
          </DashboardBand>

          {/* ── Towers ───────────────────────────────────────────────── */}
          <DashboardBand title="Control towers">
            <DashboardWidget span="half" variant="status" query={inboundHealth} contentClassName="p-0">
              <TowerSummaryCard
                title="Inbound"
                health={inboundHealth.data}
                route="/warehouse-app/dashboard/inbound"
                ctaLabel="Open inbound tower"
              />
            </DashboardWidget>
            <DashboardWidget span="half" variant="status" query={outboundHealth} contentClassName="p-0">
              <TowerSummaryCard
                title="Outbound"
                health={outboundHealth.data}
                route="/warehouse-app/dashboard/outbound"
                ctaLabel="Open outbound tower"
              />
            </DashboardWidget>
          </DashboardBand>

          {/* ── Readiness ────────────────────────────────────────────── */}
          <DashboardBand
            title="Readiness"
            description="Can the floor absorb the work that is coming?"
          >
            <DashboardWidget
              span="quarter" variant="chart"
              title="Capacity" description="Space, staging and docks."
              query={capacity}
            >
              <CapacityPanel capacity={capacity.data} />
            </DashboardWidget>

            <DashboardWidget
              span="quarter" variant="list"
              title="Labour" description="On-shift capacity and load."
              drillTo="/warehouse-app/labour"
            >
              <LabourPanel />
            </DashboardWidget>

            <DashboardWidget
              span="quarter" variant="list"
              title="Equipment" description="Scanners, printers and terminals."
              query={equipment}
            >
              <EquipmentPanel equipment={equipment.data} />
            </DashboardWidget>

            <DashboardWidget
              span="quarter" variant="list"
              title="Zone load" description="Where the open work physically sits."
              query={zones}
              isEmpty={(zones.data ?? []).length === 0}
              emptyTitle="No zone load"
            >
              <ZoneLoadPanel zones={zones.data ?? []} />
            </DashboardWidget>
          </DashboardBand>

          {/* ── Activity ─────────────────────────────────────────────── */}
          <DashboardBand title="Activity">
            <DashboardWidget
              span="full" variant="feed"
              title="Live events" description="Event stream from the floor."
              query={activity}
              isEmpty={(activity.data ?? []).length === 0}
              emptyTitle="No recent activity"
            >
              <ActivityFeed events={activity.data ?? []} />
            </DashboardWidget>
          </DashboardBand>
        </DashboardCanvas>
      </PageBody>
    </>
  );
}
