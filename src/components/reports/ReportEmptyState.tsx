/**
 * ReportEmptyState — the four ways a report can legitimately show no table.
 *
 * A report screen that renders silence is indistinguishable from a broken
 * one. Every "nothing to show" on a report surface must name which of these
 * it is:
 *
 *   no_data              the computation ran and the answer is genuinely zero rows
 *   missing_prerequisite an upstream lifecycle step has not happened yet
 *                        (no approved payroll run, GL not posted, …)
 *   failed               the computation errored
 *   missing_presentation rows exist but no column projection resolved — this is
 *                        always a defect, never a legitimate state, and is the
 *                        exact failure that hid the Branch Payroll Cost bug
 *
 * `missing_presentation` renders as a visible defect banner on purpose: the
 * user should see "the report computed N rows but cannot display them" rather
 * than an empty grid that reads as "no data".
 */
import { AlertCircle, AlertTriangle, Clock, FileX2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export type ReportEmptyStateKind =
  | "no_data"
  | "missing_prerequisite"
  | "failed"
  | "missing_presentation";

export interface ReportEmptyStateDescriptor {
  kind: ReportEmptyStateKind;
  /** Headline. Falls back to a per-kind default. */
  title?: string;
  /** Supporting sentence explaining what the user can do about it. */
  message?: string;
  /** Optional action (e.g. "Go to payroll runs"). */
  action?: React.ReactNode;
}

const PRESET: Record<
  ReportEmptyStateKind,
  { title: string; message: string; Icon: typeof FileX2; tone: string }
> = {
  no_data: {
    title: "No data for this period",
    message:
      "The report ran successfully and returned no rows for the selected criteria.",
    Icon: FileX2,
    tone: "text-muted-foreground",
  },
  missing_prerequisite: {
    title: "Waiting on an upstream step",
    message:
      "This report depends on work that has not been completed for the selected period yet.",
    Icon: Clock,
    tone: "text-amber-600 dark:text-amber-500",
  },
  failed: {
    title: "The report could not be computed",
    message: "An unexpected error occurred while building this report.",
    Icon: AlertCircle,
    tone: "text-destructive",
  },
  missing_presentation: {
    title: "This report computed rows it cannot display",
    message:
      "Data was returned but no column layout resolved for it, so nothing can be rendered. This is a configuration defect, not an empty period — report it rather than treating the report as empty.",
    Icon: AlertTriangle,
    tone: "text-destructive",
  },
};

export function ReportEmptyState({
  descriptor,
}: {
  descriptor: ReportEmptyStateDescriptor;
}) {
  const preset = PRESET[descriptor.kind];
  const Icon = preset.Icon;
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <Icon className={`h-12 w-12 mx-auto mb-4 ${preset.tone}`} />
        <p className={`font-medium ${preset.tone}`}>
          {descriptor.title ?? preset.title}
        </p>
        <p className="text-sm text-muted-foreground mt-1 max-w-xl mx-auto">
          {descriptor.message ?? preset.message}
        </p>
        {descriptor.action ? (
          <div className="mt-4 flex justify-center">{descriptor.action}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}