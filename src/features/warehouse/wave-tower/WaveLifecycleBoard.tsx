/**
 * Wave lifecycle board — each wave as a lifecycle, not a table row.
 *
 * Progress, task counts, risk and the readiness verdict all arrive from
 * `wms_wave_board`; this component only lays them out and routes actions
 * back to the guarded RPCs.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ChevronDown, ChevronRight, Gauge, PauseCircle, PlayCircle, Rocket,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { StatusBadge, EmptyState } from "@/design-system";
import { cn } from "@/lib/utils";
import {
  cutoffLabel, RISK_LABEL, RISK_TONE, WAVE_STAGE_LABEL, type WaveBoardRow,
} from "./contract";
import { WaveReadinessPanel } from "./WaveReadinessPanel";

interface Props {
  waves: WaveBoardRow[];
  onEvaluate: (waveId: string) => void;
  onRelease: (wave: WaveBoardRow) => void;
  onSuspend: (wave: WaveBoardRow) => void;
  onResume: (wave: WaveBoardRow) => void;
  busyId?: string | null;
}

export function WaveLifecycleBoard({
  waves, onEvaluate, onRelease, onSuspend, onResume, busyId,
}: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (waves.length === 0) {
    return (
      <EmptyState
        title="No live waves"
        description="Plan a wave from outbound demand, or batch orders manually below."
      />
    );
  }

  return (
    <ul className="divide-y">
      {waves.map((w) => {
        const expanded = open.has(w.wave_id);
        const releasable = ["draft", "planned", "ready"].includes(w.state);
        const busy = busyId === w.wave_id;
        return (
          <li key={w.wave_id} className="p-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => toggle(w.wave_id)}
                className="text-muted-foreground hover:text-foreground"
                aria-label={expanded ? "Collapse wave" : "Expand wave"}
              >
                {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>

              <Link to={w.drill_route} className="font-mono text-sm hover:underline">
                {w.wave_number}
              </Link>

              <StatusBadge tone={RISK_TONE[w.risk] === "healthy" ? "success"
                : RISK_TONE[w.risk] === "degraded" ? "warning"
                : RISK_TONE[w.risk] === "blocked" ? "neutral" : "danger"}>
                {RISK_LABEL[w.risk]}
              </StatusBadge>

              <span className="text-xs text-muted-foreground">
                {WAVE_STAGE_LABEL[w.lifecycle_stage] ?? w.state}
              </span>

              <span className="text-xs text-muted-foreground">
                {w.order_count} orders · {w.line_count} lines · {Number(w.ordered_units).toFixed(0)} units
              </span>

              {w.strategy_name ? (
                <span className="text-xs text-muted-foreground">· {w.strategy_name}</span>
              ) : null}

              <div className="flex-1" />

              <span className={cn("text-xs", w.risk === "late" ? "text-destructive" : "text-muted-foreground")}>
                {cutoffLabel(w.cutoff_at)}
              </span>

              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onEvaluate(w.wave_id)}>
                <Gauge className="mr-1.5 h-3.5 w-3.5" /> Check
              </Button>

              {releasable ? (
                <Button size="sm" disabled={busy} onClick={() => onRelease(w)}>
                  <Rocket className="mr-1.5 h-3.5 w-3.5" /> Release
                </Button>
              ) : w.state === "suspended" ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => onResume(w)}>
                  <PlayCircle className="mr-1.5 h-3.5 w-3.5" /> Resume
                </Button>
              ) : ["released", "picking", "picked", "packing"].includes(w.state) ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => onSuspend(w)}>
                  <PauseCircle className="mr-1.5 h-3.5 w-3.5" /> Suspend
                </Button>
              ) : null}
            </div>

            <div className="mt-2 grid gap-3 pl-6 @2xl/page:grid-cols-2">
              <div>
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>Picked</span><span>{w.pick_progress_pct}%</span>
                </div>
                <Progress value={Number(w.pick_progress_pct)} className="h-1.5" />
              </div>
              <div>
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>Packed</span><span>{w.pack_progress_pct}%</span>
                </div>
                <Progress value={Number(w.pack_progress_pct)} className="h-1.5" />
              </div>
            </div>

            {expanded ? (
              <div className="mt-3 space-y-3 rounded-lg border bg-muted/20 p-3 pl-6">
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                  <span>Tasks: {w.tasks_total} ({w.tasks_open} open, {w.tasks_in_progress} in progress)</span>
                  <span>Carrier: {w.carrier_name ?? "—"}</span>
                  <span>Dock: {w.dock_code ?? "—"}</span>
                  <span>Est. pick: {w.estimated_pick_minutes ?? "—"} min</span>
                  <span>Open exceptions: {w.open_exceptions}</span>
                </div>
                <WaveReadinessPanel readiness={w.readiness} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
