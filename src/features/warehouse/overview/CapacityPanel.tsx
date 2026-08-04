/**
 * Capacity panel — is there room, and where has it run out?
 *
 * Projection of `wms_overview_capacity`. Occupancy is only computed over
 * locations that declare a capacity; when nothing does, the panel says so
 * rather than inventing a denominator.
 */
import { Link } from "react-router-dom";
import { RadialBar, RadialBarChart, PolarAngleAxis, ResponsiveContainer } from "recharts";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/design-system";
import type { WarehouseCapacity } from "./contract";

export function CapacityPanel({ capacity }: { capacity: WarehouseCapacity | undefined }) {
  if (!capacity) {
    return <EmptyState title="No capacity data" description="Nothing is stored in scope yet." />;
  }

  const pct = capacity.occupancy_pct;
  const tone =
    pct == null ? "text-muted-foreground"
      : pct >= 90 ? "text-destructive"
      : pct >= 75 ? "text-warning"
      : "text-success";
  const fill =
    pct == null ? "hsl(var(--muted-foreground))"
      : pct >= 90 ? "hsl(var(--destructive))"
      : pct >= 75 ? "hsl(var(--warning))"
      : "hsl(var(--success))";

  const dockPct =
    capacity.dock_count > 0
      ? Math.round((capacity.dock_busy / capacity.dock_count) * 100)
      : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="relative h-24 w-24 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <RadialBarChart
              innerRadius="72%"
              outerRadius="100%"
              barSize={10}
              data={[{ name: "occupancy", value: pct ?? 0 }]}
              startAngle={90}
              endAngle={-270}
            >
              <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
              <RadialBar dataKey="value" cornerRadius={6} fill={fill} background />
            </RadialBarChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className={cn("text-lg font-semibold tabular-nums", tone)}>
              {pct == null ? "—" : `${Math.round(pct)}%`}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              full
            </span>
          </div>
        </div>

        <dl className="grid flex-1 grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Row label="Locations" value={capacity.total_locations} />
          <Row
            label="Blocked"
            value={capacity.blocked_locations}
            tone={capacity.blocked_locations > 0 ? "text-destructive" : undefined}
          />
          <Row
            label="Full bins"
            value={capacity.full_locations}
            tone={capacity.full_locations > 0 ? "text-warning" : undefined}
          />
          <Row label="Empty bins" value={capacity.empty_locations} />
        </dl>
      </div>

      <div className="grid grid-cols-3 gap-3 border-t pt-3 text-sm">
        <Row
          label="Staging"
          value={`${capacity.staging_occupied}/${capacity.staging_locations}`}
          tone={
            capacity.staging_locations > 0 &&
            capacity.staging_occupied >= capacity.staging_locations
              ? "text-destructive"
              : undefined
          }
        />
        <Row
          label="Quarantine"
          value={`${capacity.quarantine_occupied}/${capacity.quarantine_locations}`}
          tone={capacity.quarantine_occupied > 0 ? "text-warning" : undefined}
        />
        <Row
          label="Docks in use"
          value={dockPct == null ? "—" : `${capacity.dock_busy}/${capacity.dock_count}`}
          tone={dockPct != null && dockPct >= 90 ? "text-destructive" : undefined}
        />
      </div>

      {capacity.measured_locations === 0 && (
        <p className="text-xs text-muted-foreground">
          No location declares a storage capacity, so occupancy cannot be measured.{" "}
          <Button asChild variant="link" size="sm" className="h-auto p-0 text-xs">
            <Link to="/warehouse-app/layout">Set capacities in the layout editor</Link>
          </Button>
        </p>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: string;
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("text-base font-semibold tabular-nums", tone)}>{value}</dd>
    </div>
  );
}

export default CapacityPanel;
