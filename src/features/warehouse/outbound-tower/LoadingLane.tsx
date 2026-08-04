/**
 * Loading lane — the carton-level view of the staging and loading floor.
 *
 * A supervisor watching a departure window does not think in waves, they
 * think in cartons: how many are packed but not sealed, sealed but not
 * manifested, manifested but not on the trailer. Those four counts are the
 * hand-off boundaries where outbound work actually stalls.
 *
 * Every number here is a server-stamped column on the shipment contract
 * (`wms_outbound_shipments`); the lane only sums the rows it was handed for
 * display, it derives no rules of its own.
 */
import { cn } from "@/lib/utils";
import { EmptyState } from "@/design-system";
import type { OutboundShipment } from "./contract";

interface Stage {
  key: string;
  label: string;
  hint: string;
  count: number;
}

function lanes(shipments: OutboundShipment[]): Stage[] {
  let packed = 0, sealed = 0, manifested = 0, loaded = 0;
  for (const s of shipments) {
    packed += s.carton_count;
    sealed += s.carton_sealed;
    manifested += s.carton_manifested;
    loaded += s.carton_loaded;
  }
  return [
    {
      key: "awaiting_seal",
      label: "Awaiting seal",
      hint: "Packed, not sealed",
      count: Math.max(packed - sealed, 0),
    },
    {
      key: "awaiting_manifest",
      label: "Awaiting manifest",
      hint: "Sealed, not assigned to a load",
      count: Math.max(sealed - manifested, 0),
    },
    {
      key: "awaiting_load",
      label: "Awaiting load",
      hint: "Manifested, not on the trailer",
      count: Math.max(manifested - loaded, 0),
    },
    {
      key: "loaded",
      label: "Loaded",
      hint: "On the trailer",
      count: loaded,
    },
  ];
}

export function LoadingLane({ shipments }: { shipments: OutboundShipment[] }) {
  if (shipments.length === 0) {
    return (
      <EmptyState
        title="No cartons in play"
        description="Nothing is packed, staged or loading right now."
      />
    );
  }

  const stages = lanes(shipments);
  const total = stages.reduce((n, s) => n + s.count, 0) || 1;

  return (
    <div className="space-y-3">
      <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
        {stages.map((s, i) => (
          <span
            key={s.key}
            className={cn(
              i === 0 && "bg-warning",
              i === 1 && "bg-primary/60",
              i === 2 && "bg-primary",
              i === 3 && "bg-success",
            )}
            style={{ width: `${(s.count / total) * 100}%` }}
          />
        ))}
      </div>
      <dl className="grid grid-cols-2 gap-3 @xl/page:grid-cols-4">
        {stages.map((s) => (
          <div key={s.key} className="rounded-lg border p-3">
            <dt className="text-xs text-muted-foreground">{s.label}</dt>
            <dd className="text-xl font-semibold tabular-nums">{s.count}</dd>
            <dd className="text-[11px] text-muted-foreground">{s.hint}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
