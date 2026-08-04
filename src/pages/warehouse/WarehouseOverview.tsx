/**
 * Warehouse Overview — the operational home page of the Warehouse app.
 *
 * ADR 0102. This replaces the former configuration summary (warehouse and
 * location counts) *and* the separate "supervisor tower": one authoritative
 * command centre, no duplicate execution paths.
 *
 * Reading order matches how a supervisor triages a shift:
 *
 *   1. Health banner  — is the warehouse healthy, and why not?
 *   2. Priorities     — the ranked merge of flow, inbound and outbound
 *                       bottlenecks: the single "do this next" list.
 *   3. Flow spine     — receive → dispatch, where flow is breaking.
 *   4. Towers         — inbound and outbound headline, handing off to the
 *                       tower that owns the detail.
 *   5. Live work      — risk-ordered queue with inline supervisor actions.
 *   6. Capacity / labour / equipment / zones — can the floor absorb it?
 *   7. Activity       — the event fabric proving work is actually moving.
 *
 * Every number is aggregated in SQL by the module that owns it. This page
 * fetches, composes and links; it computes nothing.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { PageHeader, PageBody, Section, LoadingState, ErrorState, EmptyState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  BottleneckRail, FlowSpine, HealthBanner, LabourPanel, LiveWorkPanel, ZoneLoadPanel,
  useFlowBottlenecks, useFlowHealth, useZoneLoad, humanise, severityTone, HEALTH_TEXT,
} from "@/features/warehouse/control-center";
import { useInboundBottlenecks, useInboundHealth } from "@/features/warehouse/inbound-tower";
import { useOutboundBottlenecks, useOutboundHealth } from "@/features/warehouse/outbound-tower";
import {
  ActivityFeed, CapacityPanel, EquipmentPanel, PriorityStack, TowerSummaryCard,
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

  const stageTaskTypes = useMemo(
    () => (stage ? STAGE_TASK_TYPES[stage] ?? null : null),
    [stage],
  );

  const stages = health.data?.stages ?? [];
  const activeStageLabel = stages.find((s) => s.stage === stage)?.label;
  const openExceptions = exceptions.data ?? [];

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
        {health.isError ? (
          <ErrorState
            title="Unable to read warehouse health"
            description={(health.error as Error)?.message}
          />
        ) : health.isLoading ? (
          <LoadingState />
        ) : (
          <div className="space-y-6">
            <HealthBanner health={health.data} />

            <div className="min-w-0 grid gap-6 @4xl/page:grid-cols-3">
              <div className="min-w-0 space-y-6 @4xl/page:col-span-2">
                <Section
                  title="Act now"
                  description="Every blocker across flow, inbound and outbound, ranked by severity and impact."
                >
                  <PriorityStack items={priorities} />
                </Section>

                <Section
                  title="Flow"
                  description="Backlog, ageing and SLA risk at every stage. Select a stage to filter the work list."
                >
                  <FlowSpine
                    stages={stages}
                    activeStage={stage}
                    onSelect={(s) => setStage((cur) => (cur === s.stage ? null : s.stage))}
                  />
                </Section>

                <div className="min-w-0 grid gap-6 @2xl/page:grid-cols-2">
                  <TowerSummaryCard
                    title="Inbound"
                    health={inboundHealth.data}
                    route="/warehouse-app/dashboard/inbound"
                    ctaLabel="Open inbound tower"
                  />
                  <TowerSummaryCard
                    title="Outbound"
                    health={outboundHealth.data}
                    route="/warehouse-app/dashboard/outbound"
                    ctaLabel="Open outbound tower"
                  />
                </div>

                <Section
                  title={activeStageLabel ? `Live work — ${activeStageLabel}` : "Live work"}
                  description="Risk-ordered open work. Assign, return to pool or escalate in place."
                  actions={
                    stage && (
                      <Button variant="ghost" size="sm" onClick={() => setStage(null)}>
                        Clear stage filter
                      </Button>
                    )
                  }
                >
                  <LiveWorkPanel taskTypes={stageTaskTypes} />
                </Section>

                <Section
                  title="All bottlenecks"
                  description="Full ranked list from the flow spine, each linked to the surface that clears it."
                >
                  <BottleneckRail bottlenecks={flowBottlenecks.data ?? []} />
                </Section>
              </div>

              <div className="space-y-6">
                <Section title="Capacity" description="Space, staging and docks in scope.">
                  <CapacityPanel capacity={capacity.data} />
                </Section>

                <Section title="Labour" description="On-shift capacity and load.">
                  <LabourPanel />
                </Section>

                <Section
                  title="Exceptions"
                  description="Open blockers awaiting triage."
                  actions={
                    <Button asChild variant="ghost" size="sm">
                      <Link to="/warehouse-app/exceptions">Inbox</Link>
                    </Button>
                  }
                >
                  {openExceptions.length === 0 ? (
                    <EmptyState
                      title="No open exceptions"
                      description="Nothing is currently blocked awaiting a decision."
                    />
                  ) : (
                    <ul className="space-y-2">
                      {openExceptions.map((e) => (
                        <li key={e.id}>
                          <Link
                            to="/warehouse-app/exceptions"
                            className="flex items-start gap-2 rounded-md p-2 text-sm transition-colors hover:bg-muted/50"
                          >
                            <AlertTriangle
                              className={cn(
                                "mt-0.5 h-4 w-4 shrink-0",
                                HEALTH_TEXT[severityTone(e.severity)],
                              )}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium">{humanise(e.kind)}</div>
                              <div className="truncate text-xs text-muted-foreground">
                                {e.reason ?? humanise(e.state)}
                              </div>
                            </div>
                            <Badge variant="outline" className="shrink-0 text-[10px]">
                              {humanise(e.state)}
                            </Badge>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>

                <Section title="Equipment" description="Scanners, printers and terminals.">
                  <EquipmentPanel equipment={equipment.data} />
                </Section>

                <Section title="Zone load" description="Where the open work physically sits.">
                  <ZoneLoadPanel zones={zones.data ?? []} />
                </Section>

                <Section title="Activity" description="Live event stream from the floor.">
                  <ActivityFeed events={activity.data ?? []} />
                </Section>
              </div>
            </div>
          </div>
        )}
      </PageBody>
    </>
  );
}
