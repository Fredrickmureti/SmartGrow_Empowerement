/**
 * Inbound Control Tower.
 *
 * Not a dashboard: a control surface for the receiving supervisor. The
 * question it answers, top to bottom, is "will everything that must be
 * received today become sellable stock on time, and if not, what do I do
 * right now?".
 *
 *   1. Health banner   — inbound state and the reason for it.
 *   2. Flow spine      — appointment → gate → yard → dock → unload →
 *                        capture → inspect → cross-dock → put-away.
 *   3. Bottleneck rail — ranked causes, each linked to its fixing surface.
 *   4. Arrival board   — every open arrival as a lifecycle, risk-ordered,
 *                        with supervisor actions in place.
 *   5. Dock + yard     — the physical side: docks, trailers, waiting time.
 *   6. Window clock    — the shape of the day's booked windows.
 *
 * Every number comes from the server-side inbound contract
 * (`wms_inbound_*`), so the board cannot drift from mobile or alerting and
 * does not degrade as the site grows. Refresh is realtime-driven; there is
 * no polling and no client-side aggregation or classification.
 */
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { PageHeader, PageBody, Section, LoadingState, ErrorState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { HealthBanner, FlowSpine, LabourPanel, LiveWorkPanel } from "@/features/warehouse/control-center";
import type { FlowHealth } from "@/features/warehouse/control-center/contract";
import {
  ArrivalLifecycleBoard, ArrivalWindowTimeline, InboundBottleneckRail,
  InboundDockStrip, InboundExceptionRail,
  useInboundArrivals, useInboundBottlenecks, useInboundDockBoard, useInboundHealth,
} from "@/features/warehouse/inbound-tower";

/** Flow stage → the arrival lifecycle stage a load sits in at that stage. */
const STAGE_TO_LIFECYCLE: Record<string, string> = {
  appointment: "appointment",
  gate: "gate",
  yard: "yard",
  dock: "dock",
  unload: "unload",
  capture: "capture",
  inspect: "inspect",
  putaway: "putaway",
};

/** The task types the receiving supervisor owns on the live work list. */
const INBOUND_TASK_TYPES = ["receive", "inspect", "putaway", "count"] as const;

export default function InboundDashboard() {
  const health = useInboundHealth();
  const arrivals = useInboundArrivals();
  const bottlenecks = useInboundBottlenecks();
  const dockBoard = useInboundDockBoard();
  const [stage, setStage] = useState<string | null>(null);

  const refreshing =
    health.isFetching || arrivals.isFetching ||
    bottlenecks.isFetching || dockBoard.isFetching;

  const refresh = () => {
    health.refetch();
    arrivals.refetch();
    bottlenecks.refetch();
    dockBoard.refetch();
  };

  const stages = health.data?.stages ?? [];
  const activeLifecycle = stage ? STAGE_TO_LIFECYCLE[stage] ?? null : null;
  const activeStageLabel = stages.find((s) => s.stage === stage)?.label;

  return (
    <>
      <PageHeader
        title="Inbound control tower"
        description="Live arrival lifecycle, blockers, docks and receiving risk."
        actions={
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
            <RefreshCw className={refreshing ? "mr-2 h-4 w-4 animate-spin" : "mr-2 h-4 w-4"} />
            Refresh
          </Button>
        }
      />
      <PageBody>
        {health.isError ? (
          <ErrorState
            title="Unable to read inbound health"
            description={(health.error as Error)?.message}
          />
        ) : health.isLoading ? (
          <LoadingState />
        ) : (
          <div className="space-y-6">
            <HealthBanner health={health.data as unknown as FlowHealth} />

            <Section
              title="Inbound flow"
              description="Backlog, ageing and SLA risk at every stage. Select a stage to filter the arrival board."
            >
              <FlowSpine
                stages={stages}
                activeStage={stage}
                onSelect={(s) => setStage((cur) => (cur === s.stage ? null : s.stage))}
              />
            </Section>

            <div className="grid gap-6 @4xl/page:grid-cols-3">
              <div className="space-y-6 @4xl/page:col-span-2">
                <Section
                  title="Blockers"
                  description="Ranked by severity. Each row links to the surface that clears it."
                >
                  <InboundBottleneckRail bottlenecks={bottlenecks.data ?? []} />
                </Section>

                <Section
                  title={activeStageLabel ? `Arrivals — ${activeStageLabel}` : "Arrivals"}
                  description="Every open arrival as a lifecycle, ordered by receiving risk."
                  actions={
                    stage && (
                      <Button variant="ghost" size="sm" onClick={() => setStage(null)}>
                        Clear stage filter
                      </Button>
                    )
                  }
                >
                  {arrivals.isLoading ? (
                    <LoadingState />
                  ) : (
                    <ArrivalLifecycleBoard
                      arrivals={arrivals.data ?? []}
                      stage={activeLifecycle}
                    />
                  )}
                </Section>

                <Section
                  title="Live inbound work"
                  description="Overdue and blocked work first. Reassign, release or re-prioritise in place."
                >
                  <LiveWorkPanel taskTypes={INBOUND_TASK_TYPES} />
                </Section>
              </div>

              <div className="space-y-6">
                <Section title="Docks and yard" description="Where the trucks are.">
                  <InboundDockStrip board={dockBoard.data} />
                </Section>
                <Section title="Arrival clock" description="Open arrivals by booked window.">
                  <ArrivalWindowTimeline arrivals={arrivals.data ?? []} />
                </Section>
                <Section title="Exceptions" description="Open escalations owned by receiving.">
                  <InboundExceptionRail />
                </Section>
                <Section title="Labour" description="Who is on the floor and how loaded they are.">
                  <LabourPanel />
                </Section>
              </div>
            </div>
          </div>
        )}
      </PageBody>
    </>
  );
}
