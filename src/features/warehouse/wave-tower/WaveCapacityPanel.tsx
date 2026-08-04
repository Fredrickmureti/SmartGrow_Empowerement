/**
 * Capacity strip — can the shift absorb what the plan proposes?
 *
 * Every number comes from `wms_wave_capacity`; this component divides
 * nothing and forecasts nothing.
 */
import { Users, Clock, Gauge, Layers } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { WaveCapacity } from "./contract";

function Tile({
  icon: Icon, label, value, hint,
}: { icon: typeof Users; label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-3">
        <Icon className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-lg font-semibold leading-tight">{value}</div>
          {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function WaveCapacityPanel({ capacity }: { capacity: WaveCapacity | null | undefined }) {
  if (!capacity) return null;
  const util = capacity.utilisation_pct;
  const tone =
    util == null ? "text-muted-foreground"
      : util > 100 ? "text-destructive"
      : util > 85 ? "text-amber-600 dark:text-amber-400"
      : "text-emerald-600 dark:text-emerald-400";

  return (
    <div className="space-y-3">
      <div className="min-w-0 grid gap-3 @xl/page:grid-cols-4">
        <Tile
          icon={Users}
          label="Operators on shift"
          value={String(capacity.operators_planned)}
          hint={`${capacity.capacity_minutes} min available`}
        />
        <Tile
          icon={Clock}
          label="Committed work"
          value={`${capacity.committed_minutes} min`}
          hint="Already assigned on the floor"
        />
        <Tile
          icon={Layers}
          label="Planned waves"
          value={`${capacity.planned_wave_minutes} min`}
          hint={`${capacity.released_wave_minutes} min released · ${capacity.open_waves} open`}
        />
        <Tile
          icon={Gauge}
          label="Shift utilisation"
          value={util == null ? "—" : `${util}%`}
          hint={util != null && util > 100 ? "Plan exceeds the shift" : "Committed + planned vs capacity"}
        />
      </div>
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
