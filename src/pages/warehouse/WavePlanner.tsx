/**
 * Wave Control Tower (`/warehouse-app/waves`).
 *
 * Outbound waving is an orchestration problem, not a batching screen. The
 * page reads one server-side contract — `wms_wave_health`, `wms_wave_board`
 * and `wms_wave_demand` — and performs no aggregation, ranking or
 * classification of its own: stage counts, progress, risk and the release
 * verdict are all computed in SQL so the tower, the RF shell and alerting
 * cannot disagree.
 *
 * Actions go through guarded routines only: `wms_plan_waves` to propose,
 * `wms_evaluate_wave` to score, `release_pick_wave` to commit (which
 * re-checks readiness server-side), and `wms_transition_wave` to suspend or
 * resume. Manual batching stays available through `useCreateAndReleaseWave`
 * for the ad-hoc order the strategies did not claim.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Layers, RefreshCw, Rocket, Wand2 } from "lucide-react";
import {
  PageHeader, PageBody, Section, LoadingState, EmptyState,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useWarehouses } from "@/hooks/useWarehouses";
import {
  useCreateAndReleaseWave, useEvaluateWave, usePlanWaves, useReleaseWave,
} from "@/features/warehouse/aggregates/useDomainOperations";
import { useWaveTransition } from "@/features/warehouse/aggregates/useAggregateTransitions";
import {
  WaveDemandTable, WaveLifecycleBoard, WaveStageStrip,
  useWaveBoard, useWaveDemand, useWaveHealth, useWaveStrategies,
  type WaveBoardRow,
} from "@/features/warehouse/wave-tower";

export default function WavePlanner() {
  const { currentBusiness } = useBusinesses();
  const { warehouses } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [strategyId, setStrategyId] = useState<string>("auto");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);

  const scope = { warehouseId: warehouseId || undefined };
  const health = useWaveHealth(scope);
  const board = useWaveBoard(scope);
  const demand = useWaveDemand(scope);
  const strategies = useWaveStrategies(scope);

  const planWaves = usePlanWaves();
  const evaluateWave = useEvaluateWave();
  const releaseWave = useReleaseWave();
  const transition = useWaveTransition();
  const createAndRelease = useCreateAndReleaseWave();

  const warehouseName = useMemo(
    () => warehouses.find((w) => w.id === warehouseId)?.name ?? "",
    [warehouses, warehouseId],
  );

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handlePlan = () => {
    if (!warehouseId) return toast.error("Pick a warehouse");
    planWaves.mutate({
      warehouseId,
      strategyId: strategyId === "auto" ? null : strategyId,
    });
  };

  const handleManualRelease = () => {
    if (!warehouseId) return toast.error("Pick a warehouse");
    if (selected.size === 0) return toast.error("Select at least one sales order");
    createAndRelease.mutate(
      { warehouseId, salesOrderIds: Array.from(selected) },
      {
        onSuccess: () => {
          toast.success("Wave released — pick tasks generated");
          setSelected(new Set());
        },
      },
    );
  };

  const handleRelease = (wave: WaveBoardRow) => {
    setBusyId(wave.wave_id);
    releaseWave.mutate(
      { waveId: wave.wave_id },
      { onSettled: () => setBusyId(null) },
    );
  };

  const handleSuspend = (wave: WaveBoardRow) => {
    setBusyId(wave.wave_id);
    transition.mutate(
      { id: wave.wave_id, toState: "suspended", rowVersion: wave.row_version, reason: "Suspended from the wave tower" },
      { onSettled: () => setBusyId(null) },
    );
  };

  const handleResume = (wave: WaveBoardRow) => {
    setBusyId(wave.wave_id);
    transition.mutate(
      { id: wave.wave_id, toState: "released", rowVersion: wave.row_version, reason: "Resumed from the wave tower" },
      { onSettled: () => setBusyId(null) },
    );
  };

  const refreshAll = () => {
    void health.refetch();
    void board.refetch();
    void demand.refetch();
  };

  const totals = health.data?.totals;

  return (
    <>
      <PageHeader
        title="Wave control tower"
        description="Plan, score and release outbound waves. Readiness, progress and risk are computed server-side."
        actions={
          <Button variant="outline" size="sm" onClick={refreshAll}>
            <RefreshCw className="mr-2 h-4 w-4" /> Refresh
          </Button>
        }
      />
      <PageBody>
        <Section title="Warehouse" description="The tower is scoped to one warehouse at a time.">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={warehouseId} onValueChange={setWarehouseId}>
              <SelectTrigger className="w-full @xl/page:w-[240px]">
                <SelectValue placeholder="Choose a warehouse" />
              </SelectTrigger>
              <SelectContent>
                {warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={strategyId} onValueChange={setStrategyId}>
              <SelectTrigger className="w-full @xl/page:w-[220px]">
                <SelectValue placeholder="All active strategies" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">All active strategies</SelectItem>
                {(strategies.data ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button onClick={handlePlan} disabled={!warehouseId || planWaves.isPending}>
              <Wand2 className="mr-2 h-4 w-4" /> Plan waves
            </Button>

            {totals ? (
              <span className="text-xs text-muted-foreground">
                {totals.open_waves} open · {totals.late} late · {totals.blocked} blocked ·{" "}
                {totals.planned_hours}h planned work
              </span>
            ) : null}
          </div>
        </Section>

        {!warehouseId ? (
          <EmptyState
            icon={Layers}
            title="Choose a warehouse"
            description="Wave planning, readiness and release are all warehouse-scoped."
          />
        ) : (
          <>
            <Section title="Outbound flow" description={warehouseName}>
              {health.isLoading ? (
                <LoadingState />
              ) : health.data ? (
                <WaveStageStrip health={health.data} />
              ) : null}
            </Section>

            <Section
              title="Live waves"
              description="Each wave as a lifecycle: readiness, progress, tasks and the cut-off it serves."
            >
              <Card>
                <CardContent className="p-0">
                  {board.isLoading ? (
                    <LoadingState />
                  ) : (
                    <WaveLifecycleBoard
                      waves={board.data ?? []}
                      busyId={busyId}
                      onEvaluate={(id) => evaluateWave.mutate(id)}
                      onRelease={handleRelease}
                      onSuspend={handleSuspend}
                      onResume={handleResume}
                    />
                  )}
                </CardContent>
              </Card>
            </Section>

            <Section
              title="Unwaved demand"
              description="Open orders the strategies have not claimed. Batch them manually when the floor needs it."
            >
              <Card>
                <CardHeader className="flex-row items-center gap-2 space-y-0 pb-2">
                  <CardTitle className="text-sm">Demand</CardTitle>
                  <span className="text-xs text-muted-foreground">{selected.size} selected</span>
                  <div className="flex-1" />
                  <Button
                    size="sm"
                    disabled={selected.size === 0 || createAndRelease.isPending}
                    onClick={handleManualRelease}
                  >
                    <Rocket className="mr-2 h-4 w-4" /> Create &amp; release
                  </Button>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  {demand.isLoading ? (
                    <LoadingState />
                  ) : (
                    <WaveDemandTable
                      rows={demand.data ?? []}
                      selected={selected}
                      onToggle={toggle}
                    />
                  )}
                </CardContent>
              </Card>
            </Section>
          </>
        )}

        {!currentBusiness?.id ? null : null}
      </PageBody>
    </>
  );
}
