/**
 * Supervisor Control Center.
 *
 * Replaces the former static "supervisor dashboard" (counters reduced from a
 * 1000-row client fetch) with an operational command centre built on the
 * server-side health contract in `@/features/warehouse/control-center`:
 *
 *   1. Health banner   — is the warehouse healthy, and why not?
 *   2. Flow spine      — receive → dispatch, where is flow breaking?
 *   3. Bottleneck rail — ranked causes, each linked to the fixing surface.
 *   4. Live work       — risk-ordered queue with inline supervisor actions.
 *   5. Labour + zones  — do I have the capacity, and where is the pile?
 *
 * All aggregation happens in SQL (`wms_flow_health`, `wms_flow_bottlenecks`,
 * `wms_zone_load`) so the board scales with the warehouse and cannot drift
 * from the mobile/alerting view of the same numbers. Refresh is driven by the
 * WMS realtime channel — no polling.
 */
import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { PageHeader, PageBody, Section, LoadingState, ErrorState } from "@/design-system";
import { Button } from "@/components/ui/button";
import {
  BottleneckRail, FlowSpine, HealthBanner, LabourPanel, LiveWorkPanel, ZoneLoadPanel,
  useFlowBottlenecks, useFlowHealth, useZoneLoad,
} from "@/features/warehouse/control-center";

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

export default function SupervisorDashboard() {
  const health = useFlowHealth();
  const bottlenecks = useFlowBottlenecks();
  const zones = useZoneLoad();
  const [stage, setStage] = useState<string | null>(null);

  const refreshing = health.isFetching || bottlenecks.isFetching || zones.isFetching;
  const refresh = () => {
    health.refetch();
    bottlenecks.refetch();
    zones.refetch();
  };

  const stageTaskTypes = useMemo(
    () => (stage ? STAGE_TASK_TYPES[stage] ?? null : null),
    [stage],
  );

  const stages = health.data?.stages ?? [];
  const activeStageLabel = stages.find((s) => s.stage === stage)?.label;

  return (
    <>
      <PageHeader
        title="Supervisor control centre"
        description="Live warehouse health, flow, bottlenecks and labour."
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
            title="Unable to read warehouse health"
            description={(health.error as Error)?.message}
          />
        ) : health.isLoading ? (
          <LoadingState />
        ) : (
          <div className="space-y-6">
            <HealthBanner health={health.data} />

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

            <div className="grid gap-6 lg:grid-cols-3">
              <div className="space-y-6 lg:col-span-2">
                <Section
                  title="Bottlenecks"
                  description="Ranked by severity. Each row links to the surface that clears it."
                >
                  <BottleneckRail bottlenecks={bottlenecks.data ?? []} />
                </Section>

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
              </div>

              <div className="space-y-6">
                <Section title="Labour" description="On-shift capacity and load.">
                  <LabourPanel />
                </Section>
                <Section title="Zone load" description="Where the open work physically sits.">
                  <ZoneLoadPanel zones={zones.data ?? []} />
                </Section>
              </div>
            </div>
          </div>
        )}
      </PageBody>
    </>
  );
}
