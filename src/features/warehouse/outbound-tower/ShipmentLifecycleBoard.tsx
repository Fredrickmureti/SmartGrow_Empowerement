/**
 * Shipment lifecycle board — the spine of the Outbound Control Tower.
 *
 * A load, not a table row: every entry shows where the shipment physically
 * is (planned → dispatched), how far each stage has actually progressed,
 * what is blocking it, which dock and trailer it is bound to, and how long
 * is left before its departure window. Ordering is by risk, so the load that
 * needs a supervisor is always the first one on screen.
 *
 * All values come from `wms_outbound_shipments`; this component performs no
 * aggregation and owns no business rules.
 */
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowUpRight, Ban, Clock, PackageCheck, Truck } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/design-system";
import { ShipmentActions } from "./ShipmentActions";
import {
  HEALTH_FILL, HEALTH_TEXT, LIFECYCLE_LABEL, LIFECYCLE_ORDER, RISK_LABEL,
  RISK_TONE, departureCountdown, shipmentKey, shipmentLabel,
  type OutboundShipment,
} from "./contract";

interface Props {
  shipments: OutboundShipment[];
  /** Optional lifecycle-stage filter driven by the flow spine. */
  stage?: string | null;
  limit?: number;
}

export function ShipmentLifecycleBoard({ shipments, stage, limit = 40 }: Props) {
  const rows = (stage ? shipments.filter((s) => s.lifecycle_stage === stage) : shipments)
    .slice(0, limit);

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No open loads"
        description={
          stage
            ? "No shipment is sitting at this stage right now."
            : "Every outbound load has been dispatched."
        }
      />
    );
  }

  return (
    <ul className="space-y-2">
      {rows.map((s) => (
        <ShipmentRow key={shipmentKey(s)} shipment={s} />
      ))}
    </ul>
  );
}

function ShipmentRow({ shipment: s }: { shipment: OutboundShipment }) {
  const tone = RISK_TONE[s.risk];
  const urgent = s.risk === "breached" || s.risk === "blocked";

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "rounded-lg border p-3 transition-colors",
        urgent ? "border-destructive/40 bg-destructive/5" : "bg-card",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-full @xl/page:basis-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={s.drill_route}
              className="truncate font-medium hover:underline"
            >
              {shipmentLabel(s)}
            </Link>
            <Badge variant="outline" className="text-xs">
              {LIFECYCLE_LABEL[s.lifecycle_stage]}
            </Badge>
            <span className={cn("text-xs font-semibold uppercase", HEALTH_TEXT[tone])}>
              {RISK_LABEL[s.risk]}
            </span>
            {s.exception_count > 0 && (
              <span className="flex items-center gap-1 text-xs text-destructive">
                <AlertTriangle className="h-3 w-3" />
                {s.exception_count}
              </span>
            )}
          </div>

          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {departureCountdown(s.minutes_to_departure)}
            </span>
            <span className="flex items-center gap-1">
              <PackageCheck className="h-3 w-3" />
              {s.carton_count} cartons · {s.line_count} lines
            </span>
            <span className="flex items-center gap-1">
              <Truck className="h-3 w-3" />
              {s.dock_code ?? "no dock"}
              {s.trailer_ref ? ` · ${s.trailer_ref}` : ""}
            </span>
            {s.unassigned_tasks > 0 && (
              <span>{s.unassigned_tasks} unassigned</span>
            )}
          </p>

          {s.blocked_reason && (
            <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
              <Ban className="h-3 w-3" /> {s.blocked_reason}
            </p>
          )}

          <StageTrack shipment={s} />
        </div>

        <div className="flex w-full shrink-0 items-center justify-end gap-2 @xl/page:w-auto">
          <ShipmentActions shipment={s} />
          <Link
            to={s.drill_route}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Open <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </motion.li>
  );
}

/** Lifecycle rail with real pick / pack / load completion inside it. */
function StageTrack({ shipment: s }: { shipment: OutboundShipment }) {
  const reached = LIFECYCLE_ORDER.indexOf(s.lifecycle_stage);
  const tone = RISK_TONE[s.risk];

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex gap-0.5">
        {LIFECYCLE_ORDER.map((st, i) => (
          <span
            key={st}
            title={LIFECYCLE_LABEL[st]}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              i <= reached ? HEALTH_FILL[tone] : "bg-muted",
            )}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
        <Meter label="Picked" pct={s.pick_pct} />
        <Meter label="Packed" pct={s.pack_pct} />
        <Meter label="Loaded" pct={s.load_pct} />
      </div>
    </div>
  );
}

function Meter({ label, pct }: { label: string; pct: number | null }) {
  if (pct === null || pct === undefined) return null;
  return (
    <span className="flex items-center gap-1.5">
      <span>{label}</span>
      <span className="h-1 w-16 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </span>
      <span className="tabular-nums">{Math.round(pct)}%</span>
    </span>
  );
}
