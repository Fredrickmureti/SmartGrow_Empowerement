/**
 * Wave stage strip — the outbound spine, as the server sees it.
 *
 * Renders `wms_wave_health.stages` verbatim. Nothing here counts, ranks or
 * classifies; the SQL contract already did.
 */
import { cn } from "@/lib/utils";
import {
  STAGE_HEALTH_SURFACE, STAGE_HEALTH_TEXT, type WaveHealth,
} from "./contract";

export function WaveStageStrip({ health }: { health: WaveHealth }) {
  return (
    <div className="grid grid-cols-2 gap-2 @3xl/page:grid-cols-5">
      {health.stages.map((s) => (
        <div
          key={s.stage}
          className={cn("rounded-lg border p-3", STAGE_HEALTH_SURFACE[s.health])}
        >
          <div className="text-xs text-muted-foreground">{s.label}</div>
          <div className={cn("text-2xl font-semibold tabular-nums", STAGE_HEALTH_TEXT[s.health])}>
            {s.count}
          </div>
        </div>
      ))}
    </div>
  );
}
