/**
 * Wave stage strip — the outbound spine, as the server sees it.
 *
 * Renders `wms_wave_health.stages` verbatim. Nothing here counts, ranks or
 * classifies; the SQL contract already did.
 *
 * Presentation is the canonical ERP stat card (`SummaryStatCard`) — stage
 * health maps onto the shared tone scale and drives the accent rule, so an
 * outbound stage reads exactly like an AR aging bucket.
 */
import { SummaryStatCard, SummaryStatGrid } from "@/design-system";
import type { SummaryStatTone } from "@/design-system";
import type { WaveHealth, WaveStageHealth } from "./contract";

const STAGE_TONE: Record<WaveStageHealth, SummaryStatTone> = {
  ok: "neutral",
  warning: "warn",
  critical: "bad",
  idle: "neutral",
};

export function WaveStageStrip({
  health,
  loading = false,
}: {
  health: WaveHealth;
  loading?: boolean;
}) {
  return (
    <SummaryStatGrid>
      {health.stages.map((s) => (
        <SummaryStatCard
          key={s.stage}
          label={s.label}
          value={s.count}
          tone={STAGE_TONE[s.health]}
          accent={s.health === "warning" || s.health === "critical"}
          loading={loading}
          to={`/warehouse-app/waves?stage=${encodeURIComponent(s.stage)}`}
        />
      ))}
    </SummaryStatGrid>
  );
}
