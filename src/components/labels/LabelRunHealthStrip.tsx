/**
 * LabelRunHealthStrip — operator-facing mirror of the label-run SLO arm
 * in `check-print-queue-slo`.
 *
 * The nightly monitor raises platform alerts; an ops user should not
 * have to read an alert table to learn that a run wedged or that the
 * catalogue is refusing a fifth of its lines. Each breach here names
 * the failure *and* the person who can fix it, because the three
 * signals have three different owners:
 *
 *   • stalled run      — the engine/drainer isn't advancing work
 *   • refusal ratio    — the catalogue has no printable identity
 *   • aging demand     — nobody is turning demand into runs
 */
import { AlertTriangle, Ban, CheckCircle2, Clock } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { LABEL_SLO, useLabelRunHealth } from "@/hooks/inventory/useLabelRuns";

interface Props {
  businessId: string | null;
}

export function LabelRunHealthStrip({ businessId }: Props) {
  const { data: health, isLoading } = useLabelRunHealth(businessId);

  if (isLoading || !health) return null;

  if (health.healthy) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4 text-primary" />
        Label engine within SLO — no stalled runs, refusals or aging demand.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {health.stalledRuns > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {health.stalledRuns} run{health.stalledRuns === 1 ? "" : "s"} have not advanced in{" "}
            {LABEL_SLO.runStallMinutes} minutes
          </AlertTitle>
          <AlertDescription>
            The run is still marked as expanding or running but no line has moved. Check the
            print queue drainer, then pause and resume the run to re-claim it.
          </AlertDescription>
        </Alert>
      )}

      {health.refusalBreach && (
        <Alert>
          <Ban className="h-4 w-4" />
          <AlertTitle>
            {(health.refusedRatio * 100).toFixed(0)}% of label lines refused in the last 24h (
            {health.refusedLines}/{health.totalLines})
          </AlertTitle>
          <AlertDescription>
            Refused lines are items with no printable barcode identity — the engine will not
            print a label carrying an internal id. Fix the catalogue identifiers, then retry the
            affected runs.
          </AlertDescription>
        </Alert>
      )}

      {health.agingBreach && (
        <Alert>
          <Clock className="h-4 w-4" />
          <AlertTitle>
            {health.agingDemand} item{health.agingDemand === 1 ? "" : "s"} have needed a label for
            over {LABEL_SLO.demandAgeHours}h
          </AlertTitle>
          <AlertDescription>
            Demand is being raised but not printed. Shelf edges are out of date with the till —
            submit a run from the demand tab or dismiss what no longer applies.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
