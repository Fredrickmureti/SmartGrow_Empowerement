/**
 * Arrival lifecycle board — the spine of the Inbound Control Tower.
 *
 * A truck, not a table row: every entry shows where the load physically is
 * (booked → available), how far the receipt has progressed, what is holding
 * it, which dock and trailer it is on, and how long is left before its
 * booked window. Ordering is by risk, so the arrival that needs a supervisor
 * is always first on screen.
 *
 * All values come from `wms_inbound_arrivals`; this component performs no
 * aggregation and owns no business rules.
 */
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowUpRight, Clock, PackageCheck, Truck, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/design-system";
import { ArrivalActions } from "./ArrivalActions";
import {
  ARRIVAL_LABEL, ARRIVAL_ORDER, HEALTH_FILL, HEALTH_TEXT, RISK_LABEL,
  RISK_TONE, arrivalKey, arrivalLabel, windowCountdown,
  type InboundArrival,
} from "./contract";

interface Props {
  arrivals: InboundArrival[];
  /** Optional lifecycle-stage filter driven by the flow spine. */
  stage?: string | null;
  limit?: number;
}

export function ArrivalLifecycleBoard({ arrivals, stage, limit = 40 }: Props) {
  const rows = (stage ? arrivals.filter((a) => a.lifecycle_stage === stage) : arrivals)
    .slice(0, limit);

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No open arrivals"
        description={
          stage
            ? "Nothing is sitting at this stage right now."
            : "Every booked load has been received and put away."
        }
      />
    );
  }

  return (
    <ul className="space-y-2">
      {rows.map((a) => (
        <ArrivalRow key={arrivalKey(a)} arrival={a} />
      ))}
    </ul>
  );
}

function ArrivalRow({ arrival: a }: { arrival: InboundArrival }) {
  const tone = RISK_TONE[a.risk];
  const urgent = a.risk === "breached" || a.risk === "blocked";

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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={a.drill_route} className="truncate font-medium hover:underline">
              {arrivalLabel(a)}
            </Link>
            <Badge variant="outline" className="text-xs">
              {ARRIVAL_LABEL[a.lifecycle_stage]}
            </Badge>
            <span className={cn("text-xs font-semibold uppercase", HEALTH_TEXT[tone])}>
              {RISK_LABEL[a.risk]}
            </span>
            {a.exception_count > 0 && (
              <span className="flex items-center gap-1 text-xs text-destructive">
                <AlertTriangle className="h-3 w-3" />
                {a.exception_count}
              </span>
            )}
          </div>

          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {windowCountdown(a.minutes_to_window)}
              {a.dwell_minutes ? ` · ${Math.round(a.dwell_minutes)}m on site` : ""}
            </span>
            <span className="flex items-center gap-1">
              <PackageCheck className="h-3 w-3" />
              {a.captured_lines}/{a.line_count} lines
            </span>
            <span className="flex items-center gap-1">
              <Truck className="h-3 w-3" />
              {a.dock_code ?? a.yard_slot_code ?? "no dock"}
              {a.trailer_ref ? ` · ${a.trailer_ref}` : ""}
            </span>
            {a.carrier_name && <span>{a.carrier_name}</span>}
            {a.qc_pending > 0 && (
              <span className="flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" />
                {a.qc_pending} in QC
              </span>
            )}
            {a.putaway_open > 0 && <span>{a.putaway_open} put-away open</span>}
            {a.crossdock_pending > 0 && <span>{a.crossdock_pending} cross-dock</span>}
          </p>

          <DiscrepancyStrip arrival={a} />
          <StageTrack arrival={a} />
        </div>

        <div className="flex w-full shrink-0 items-center justify-end gap-2 @xl/page:w-auto">
          <ArrivalActions arrival={a} />
          <Link
            to={a.drill_route}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Open <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </motion.li>
  );
}

/** Short / over / damaged / hold counts, only when they exist. */
function DiscrepancyStrip({ arrival: a }: { arrival: InboundArrival }) {
  const parts = [
    a.short_lines > 0 ? `${a.short_lines} short` : null,
    a.over_lines > 0 ? `${a.over_lines} over` : null,
    a.damaged_lines > 0 ? `${a.damaged_lines} damaged` : null,
    a.hold_lines > 0 ? `${a.hold_lines} on hold` : null,
    a.unexpected_lines > 0 ? `${a.unexpected_lines} unexpected` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <p className="mt-1 text-xs font-medium text-destructive">{parts.join(" · ")}</p>
  );
}

/** Lifecycle rail with real receive / capture / put-away completion in it. */
function StageTrack({ arrival: a }: { arrival: InboundArrival }) {
  const reached = ARRIVAL_ORDER.indexOf(a.lifecycle_stage);
  const tone = RISK_TONE[a.risk];
  const capturePct = a.line_count > 0
    ? Math.round((a.captured_lines / a.line_count) * 100) : null;
  const putawayTotal = a.putaway_open + a.putaway_done;
  const putawayPct = putawayTotal > 0
    ? Math.round((a.putaway_done / putawayTotal) * 100) : null;

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex gap-0.5">
        {ARRIVAL_ORDER.map((st, i) => (
          <span
            key={st}
            title={ARRIVAL_LABEL[st]}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              i <= reached ? HEALTH_FILL[tone] : "bg-muted",
            )}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
        <Meter label="Received" pct={a.receive_pct} />
        <Meter label="Captured" pct={capturePct} />
        <Meter label="Put away" pct={putawayPct} />
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
