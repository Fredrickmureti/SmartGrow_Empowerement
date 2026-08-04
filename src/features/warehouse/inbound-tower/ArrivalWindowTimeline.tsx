/**
 * Arrival window timeline — the shape of the receiving day.
 *
 * Buckets the open arrivals by their booked window so a supervisor can see
 * the wall of trucks coming before it lands. Bucketing is presentation only;
 * every arrival, its stage and its risk come from the server contract.
 */
import { cn } from "@/lib/utils";
import { EmptyState } from "@/design-system";
import { RISK_TONE, HEALTH_FILL, type InboundArrival } from "./contract";

const BUCKETS = [
  { key: "late", label: "Overdue" },
  { key: "now", label: "Next hour" },
  { key: "soon", label: "1–4h" },
  { key: "today", label: "4–12h" },
  { key: "later", label: "Later" },
] as const;

function bucketOf(a: InboundArrival): (typeof BUCKETS)[number]["key"] | null {
  const m = a.minutes_to_window;
  if (m === null || m === undefined) return null;
  if (m < 0) return "late";
  if (m < 60) return "now";
  if (m < 240) return "soon";
  if (m < 720) return "today";
  return "later";
}

export function ArrivalWindowTimeline({ arrivals }: { arrivals: InboundArrival[] }) {
  const open = arrivals.filter((a) => a.lifecycle_stage !== "available");
  if (open.length === 0) {
    return <EmptyState title="Nothing booked" description="No arrival window is open." />;
  }

  const peak = Math.max(
    1,
    ...BUCKETS.map((b) => open.filter((a) => bucketOf(a) === b.key).length),
  );

  return (
    <ul className="space-y-2">
      {BUCKETS.map((b) => {
        const rows = open.filter((a) => bucketOf(a) === b.key);
        const worst = rows.some((r) => r.risk === "breached")
          ? "breached"
          : rows.some((r) => r.risk === "blocked")
            ? "blocked"
            : rows.some((r) => r.risk === "at_risk")
              ? "at_risk"
              : "normal";
        return (
          <li key={b.key} className="flex items-center gap-3 text-sm">
            <span className="w-20 shrink-0 text-xs text-muted-foreground">{b.label}</span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className={cn("block h-full rounded-full", HEALTH_FILL[RISK_TONE[worst]])}
                style={{ width: `${(rows.length / peak) * 100}%` }}
              />
            </span>
            <span className="w-6 shrink-0 text-right tabular-nums">{rows.length}</span>
          </li>
        );
      })}
      <li className="pt-1 text-xs text-muted-foreground">
        {open.filter((a) => a.minutes_to_window === null).length} unbooked on site
      </li>
    </ul>
  );
}
