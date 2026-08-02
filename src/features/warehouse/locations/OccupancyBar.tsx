/**
 * OccupancyBar — capacity fill for a location, using semantic tokens only.
 */
import { cn } from "@/lib/utils";

export function OccupancyBar({ pct }: { pct: number | null | undefined }) {
  if (pct === null || pct === undefined) {
    return <div className="h-1.5 w-full rounded-full bg-muted" aria-hidden />;
  }
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="img"
      aria-label={`${Math.round(clamped)} percent full`}
      title={`${Math.round(clamped)}% full`}
    >
      <div
        className={cn(
          "h-full rounded-full transition-all",
          clamped >= 95 ? "bg-destructive" : clamped >= 75 ? "bg-primary" : "bg-primary/50",
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
