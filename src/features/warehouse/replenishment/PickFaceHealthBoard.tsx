/**
 * Pick-face health board (ADR 0108).
 *
 * Ranks the pick faces covered by open replenishment orders by how exposed
 * they are — projected position from the engine's decision trace, tiered with
 * the shared `pickFaceHealth` vocabulary from the reference engine.
 */
import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/design-system";
import { Gauge } from "lucide-react";
import { pickFaceHealth, type PickFaceHealthTier } from "@/lib/warehouse/replenishment/engine";
import type { ReplenOrderRow } from "./useReplenOrders";

const TIER_CLASS: Record<PickFaceHealthTier, string> = {
  stockout: "bg-destructive/15 text-destructive border-destructive/30",
  critical: "bg-destructive/10 text-destructive border-destructive/20",
  low: "bg-warning/10 text-warning-foreground border-warning/30",
  healthy: "bg-muted text-muted-foreground border-border",
};

const TIER_LABEL: Record<PickFaceHealthTier, string> = {
  stockout: "Stocked out",
  critical: "Critical",
  low: "Low",
  healthy: "Healthy",
};

interface Props {
  orders: ReplenOrderRow[];
}

export function PickFaceHealthBoard({ orders }: Props) {
  const rows = useMemo(() => {
    return orders
      .map((o) => {
        const t = (o.decision_trace ?? {}) as { projected?: number; min_qty?: number; velocity_per_hour?: number };
        const projected = Number(t.projected ?? 0);
        const perHour = Number(t.velocity_per_hour ?? 0);
        const minutes = perHour > 0 ? (projected / perHour) * 60 : null;
        return {
          id: o.id,
          code: o.pick_loc?.code ?? "—",
          product: o.product?.name ?? "—",
          projected,
          minQty: t.min_qty ?? null,
          minutes,
          tier: pickFaceHealth(minutes, projected),
        };
      })
      .sort((a, b) => {
        const rank: Record<PickFaceHealthTier, number> = { stockout: 0, critical: 1, low: 2, healthy: 3 };
        if (rank[a.tier] !== rank[b.tier]) return rank[a.tier] - rank[b.tier];
        return a.projected - b.projected;
      })
      .slice(0, 12);
  }, [orders]);

  if (rows.length === 0) {
    return <EmptyState icon={Gauge} title="No exposed pick faces" description="Run the planner to assess pick-face health." />;
  }

  return (
    <div className="grid gap-3 @xl/page:grid-cols-2 @4xl/page:grid-cols-3">
      {rows.map((r) => (
        <Card key={r.id} className={`border ${TIER_CLASS[r.tier]}`}>
          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="font-mono text-sm">{r.code}</div>
              <Badge variant="outline">{TIER_LABEL[r.tier]}</Badge>
            </div>
            <div className="mt-1 truncate text-sm font-medium">{r.product}</div>
            <div className="mt-2 text-xs">
              Projected {r.projected}
              {r.minQty != null ? ` · min ${r.minQty}` : ""}
              {r.minutes != null ? ` · ~${Math.round(r.minutes)} min to empty` : ""}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
