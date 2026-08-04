/**
 * Departure timeline — outbound load plotted against the clock.
 *
 * Buckets the open loads by hour relative to now so a supervisor can see the
 * shape of the day: what is already late, what leaves in the next hour, and
 * where the peak sits. Purely a projection of the shipment contract — the
 * risk classification itself is server-side.
 */
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState } from "@/design-system";
import type { OutboundShipment } from "./contract";

interface Bucket { label: string; count: number; late: boolean }

export function DepartureTimeline({ shipments }: { shipments: OutboundShipment[] }) {
  const open = shipments.filter(
    (s) => s.lifecycle_stage !== "dispatched" && s.minutes_to_departure !== null,
  );

  if (open.length === 0) {
    return (
      <EmptyState
        title="No planned departures"
        description="No open load carries a departure window."
      />
    );
  }

  const buckets = new Map<number, Bucket>();
  for (const s of open) {
    const hour = Math.floor((s.minutes_to_departure ?? 0) / 60);
    const clamped = Math.max(-4, Math.min(11, hour));
    const label = clamped < 0 ? `${Math.abs(clamped)}h late` : `+${clamped}h`;
    const bucket = buckets.get(clamped) ?? { label, count: 0, late: clamped < 0 };
    bucket.count += 1;
    buckets.set(clamped, bucket);
  }

  const data = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => b);

  return (
    <div className="h-48 w-full min-w-0 max-w-full overflow-hidden">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
          <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted))" }}
            contentStyle={{
              background: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(v: number) => [`${v} loads`, "Departures"]}
          />
          <Bar dataKey="count" radius={[4, 4, 0, 0]}>
            {data.map((b, i) => (
              <Cell
                key={i}
                fill={b.late ? "hsl(var(--destructive))" : "hsl(var(--primary))"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
