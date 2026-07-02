import { Alert, AlertDescription } from "@/components/ui/alert";
import { Lock } from "lucide-react";
import { useFiscalPeriods } from "@/hooks/useFiscalPeriods";
import { useMemo } from "react";
import { format } from "date-fns";

interface PeriodLockBannerProps {
  /** Inclusive start date of the report range (yyyy-mm-dd) */
  dateFrom?: string;
  /** Inclusive end date / as-of date of the report range (yyyy-mm-dd) */
  dateTo: string;
}

/**
 * PeriodLockBanner
 *
 * Renders a non-intrusive banner when the report's date range overlaps any
 * closed (locked) fiscal period. Communicates to accountants that the figures
 * for those periods are stable and cannot change due to back-dated entries.
 */
export function PeriodLockBanner({ dateFrom, dateTo }: PeriodLockBannerProps) {
  const { periods } = useFiscalPeriods();

  const lockedPeriods = useMemo(() => {
    if (!dateTo) return [];
    const rangeStart = dateFrom ? new Date(dateFrom) : new Date("1970-01-01");
    const rangeEnd = new Date(dateTo);
    return periods.filter((p) => {
      if (p.status !== "closed") return false;
      const pStart = new Date(p.start_date);
      const pEnd = new Date(p.end_date);
      // Overlap if periodStart <= rangeEnd AND periodEnd >= rangeStart
      return pStart <= rangeEnd && pEnd >= rangeStart;
    });
  }, [periods, dateFrom, dateTo]);

  if (lockedPeriods.length === 0) return null;

  const summary =
    lockedPeriods.length === 1
      ? `Period "${lockedPeriods[0].name}" (${format(new Date(lockedPeriods[0].start_date), "MMM d, yyyy")} – ${format(new Date(lockedPeriods[0].end_date), "MMM d, yyyy")}) is closed`
      : `${lockedPeriods.length} fiscal periods in this range are closed`;

  return (
    <Alert className="border-l-4 border-l-primary bg-primary/5">
      <Lock className="h-4 w-4" />
      <AlertDescription className="text-sm">
        <span className="font-medium">{summary}.</span>{" "}
        <span className="text-muted-foreground">
          Figures for closed periods are locked — back-dated entries are blocked.
        </span>
      </AlertDescription>
    </Alert>
  );
}
