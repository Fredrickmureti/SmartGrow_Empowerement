/**
 * Capacity strip — can the shift absorb what the plan proposes?
 *
 * Every number comes from `wms_wave_capacity`; this component divides
 * nothing and forecasts nothing. Presentation is the canonical ERP stat
 * card so the shift-capacity strip matches Finance/AR summary strips.
 */
import { Users, Clock, Gauge, Layers } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { SummaryStatCard, SummaryStatGrid, toneText, toneFromStat } from "@/design-system";
import type { WaveCapacity } from "./contract";

export function WaveCapacityPanel({
  capacity,
  loading = false,
}: {
  capacity: WaveCapacity | null | undefined;
  loading?: boolean;
}) {
  if (!capacity) return null;
  const util = capacity.utilisation_pct;
  const utilTone =
    util == null ? "neutral" : util > 100 ? "bad" : util > 85 ? "warn" : "ok";
  const tone = toneText(toneFromStat(utilTone));

  return (
    <div className="space-y-3">
      <SummaryStatGrid>
        <SummaryStatCard
          icon={<Users className="h-3.5 w-3.5" />}
          label="Operators on shift"
          value={capacity.operators_planned}
          footer={`${capacity.capacity_minutes} min available`}
          loading={loading}
          to="/warehouse-app/labour"
        />
        <SummaryStatCard
          icon={<Clock className="h-3.5 w-3.5" />}
          label="Committed work"
          value={`${capacity.committed_minutes} min`}
          footer="Already assigned on the floor"
          loading={loading}
          to="/warehouse-app/tasks"
        />
        <SummaryStatCard
          icon={<Layers className="h-3.5 w-3.5" />}
          label="Planned waves"
          value={`${capacity.planned_wave_minutes} min`}
          footer={`${capacity.released_wave_minutes} min released \u00b7 ${capacity.open_waves} open`}
          loading={loading}
          to="/warehouse-app/waves"
        />
        <SummaryStatCard
          icon={<Gauge className="h-3.5 w-3.5" />}
          label="Shift utilisation"
          value={util == null ? "\u2014" : `${util}%`}
          footer={util != null && util > 100 ? "Plan exceeds the shift" : "Committed + planned vs capacity"}
          tone={utilTone}
          accent={util != null && util > 85}
          loading={loading}
        />
      </SummaryStatGrid>
      {util != null ? (
        <div>
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Shift load</span>
            <span className={cn(tone)}>{util}%</span>
          </div>
          <Progress value={Math.min(util, 100)} className="h-1.5" />
        </div>
      ) : null}
    </div>
  );
}
