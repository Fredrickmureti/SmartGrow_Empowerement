/**
 * Outbound Control Tower.
 *
 * Not a dashboard: a control surface for the shipping supervisor. The
 * question it answers, top to bottom, is "can everything that must leave
 * today leave on time, and if not, what do I do right now?".
 *
 *   1. Health banner   — outbound state and the reason for it.
 *   2. Flow spine      — release → pick → pack → stage → load → dispatch.
 *   3. Bottleneck rail — ranked causes, each linked to its fixing surface.
 *   4. Shipment board  — every open load as a lifecycle, risk-ordered, with
 *                        supervisor actions in place.
 *   5. Dock + yard     — the physical side: docks, trailers, waiting time.
 *   6. Departure clock — the shape of the day's departure windows.
 *
 * Every number comes from the server-side outbound contract
 * (`wms_outbound_*`), so the board cannot drift from mobile or alerting and
 * does not degrade as the warehouse grows. Refresh is realtime-driven; there
 * is no polling and no client-side aggregation.
 */
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { PageHeader, PageBody, Section, LoadingState, ErrorState } from "@/design-system";
import { Button } from "@/components/ui/button";
import {
  HealthBanner, FlowSpine, LabourPanel, LiveWorkPanel,
} from "@/features/warehouse/control-center";
import {
  DepartureTimeline, DockYardStrip, ExceptionRail, LoadingLane,
  OutboundBottleneckRail, ShipmentLifecycleBoard,
  useOutboundBottlenecks, useOutboundDockBoard, useOutboundHealth, useOutboundShipments,
} from "@/features/warehouse/outbound-tower";

/** Flow stage → the lifecycle stages a load sits in while at that stage. */
const STAGE_TO_LIFECYCLE: Record<string, string> = {
  release: "planned",
  pick: "picking",
  pack: "packing",
  stage: "staged",
  load: "loading",
  dispatch: "sealed",
};

/** The task types the shipping supervisor owns on the live work list. */
const OUTBOUND_TASK_TYPES = [
  "replenish", "pick", "pack", "stage", "load", "dispatch",
] as const;


export default function OutboundDashboard() {
  const health = useOutboundHealth();
  const shipments = useOutboundShipments();
  const bottlenecks = useOutboundBottlenecks();
  const dockBoard = useOutboundDockBoard();
  const [stage, setStage] = useState<string | null>(null);

  const refreshing =
    health.isFetching || shipments.isFetching ||
    bottlenecks.isFetching || dockBoard.isFetching;

  const refresh = () => {
    health.refetch();
    shipments.refetch();
    bottlenecks.refetch();
    dockBoard.refetch();
  };

  const stages = health.data?.stages ?? [];
  const activeLifecycle = stage ? STAGE_TO_LIFECYCLE[stage] ?? null : null;
  const activeStageLabel = stages.find((s) => s.stage === stage)?.label;

  return (
    <>
      <PageHeader
        title="Outbound control tower"
        description="Live shipment lifecycle, blockers, docks and departure risk."
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
            title="Unable to read outbound health"
            description={(health.error as Error)?.message}
          />
        ) : health.isLoading ? (
          <LoadingState />
        ) : (
          <div className="space-y-6">
            <HealthBanner health={health.data} />

            <Section
              title="Outbound flow"
              description="Backlog, ageing and departure risk at every stage. Select a stage to filter the shipment board."
            >
              <FlowSpine
                stages={stages}
                activeStage={stage}
                onSelect={(s) => setStage((cur) => (cur === s.stage ? null : s.stage))}
              />
            </Section>

            <div className="grid min-w-0 max-w-full grid-cols-1 gap-6 @4xl/page:grid-cols-3">
              <div className="min-w-0 max-w-full space-y-6 @4xl/page:col-span-2">
                <Section
                  title="Blockers"
                  description="Ranked by severity. Each row links to the surface that clears it."
                >
                  <OutboundBottleneckRail bottlenecks={bottlenecks.data ?? []} />
                </Section>

                <Section
                  title={activeStageLabel ? `Shipments — ${activeStageLabel}` : "Shipments"}
                  description="Every open load as a lifecycle, ordered by departure risk."
                  actions={
                    stage && (
                      <Button variant="ghost" size="sm" onClick={() => setStage(null)}>
                        Clear stage filter
                      </Button>
                    )
                  }
                >
                  {shipments.isLoading ? (
                    <LoadingState />
                  ) : (
                    <ShipmentLifecycleBoard
                      shipments={shipments.data ?? []}
                      stage={activeLifecycle}
                    />
                  )}
                </Section>

                <Section
                  title="Carton flow"
                  description="Where cartons are stalling between pack, seal, manifest and trailer."
                >
                  <LoadingLane shipments={shipments.data ?? []} />
                </Section>

                <Section
                  title="Live outbound work"
                  description="Overdue and blocked work first. Reassign, release or re-prioritise in place."
                >
                  <LiveWorkPanel taskTypes={OUTBOUND_TASK_TYPES} />
                </Section>
              </div>

              <div className="min-w-0 max-w-full space-y-6">
                <Section title="Docks and yard" description="Where the trucks are.">
                  <DockYardStrip board={dockBoard.data} />
                </Section>
                <Section title="Departure clock" description="Open loads by departure window.">
                  <DepartureTimeline shipments={shipments.data ?? []} />
                </Section>
                <Section title="Exceptions" description="Open escalations owned by shipping.">
                  <ExceptionRail />
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
