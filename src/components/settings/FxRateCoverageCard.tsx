/**
 * Rate coverage indicator (Phase 8 of the currency architecture remediation).
 *
 * Answers the only question a finance manager has before month end: "will any
 * document be refused for want of a rate?" It reports what the server computed
 * in `fx_rate_coverage_summary` — usage, coverage extent, provenance and
 * staleness — and offers one action: record a dated override for the gap.
 *
 * Presentation only. No rate is derived, guessed or defaulted here.
 */

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import type { FxCoverageRow, FxCoverageStatus, FxCoverageSummary } from "@/hooks/useFxRateCoverage";

const STATUS_LABEL: Record<FxCoverageStatus, string> = {
  none: "No rate on file",
  partial: "Gap before coverage",
  stale: "Rate is stale",
  covered: "Covered",
};

function statusVariant(status: FxCoverageStatus): "default" | "secondary" | "outline" | "destructive" {
  if (status === "none") return "destructive";
  if (status === "partial") return "default";
  if (status === "stale") return "secondary";
  return "outline";
}

/** Earliest date that still needs a rate, so the override opens pre-aimed. */
function gapDate(row: FxCoverageRow): string | undefined {
  if (row.status === "none") return row.first_used_on ?? undefined;
  if (row.status === "partial") return row.first_used_on ?? undefined;
  return undefined;
}

interface Props {
  summary: FxCoverageSummary | null;
  isLoading: boolean;
  error: string | null;
  canEdit: boolean;
  onRefresh: () => void;
  onRecordRate: (currency: string, effectiveDate?: string) => void;
}

export function FxRateCoverageCard({
  summary,
  isLoading,
  error,
  canEdit,
  onRefresh,
  onRecordRate,
}: Props) {
  const rows = summary?.coverage ?? [];
  const gaps =
    (summary?.currencies_without_any_rate ?? 0) +
    (summary?.currencies_partially_covered ?? 0);
  const healthy = summary != null && gaps === 0 && (summary.currencies_stale ?? 0) === 0;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>Rate Coverage</CardTitle>
          <CardDescription>
            Which foreign currencies this company actually transacts in, and whether the
            rate book reaches back far enough to support them. A document dated before
            coverage is refused — never posted at 1:1.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="text-sm text-destructive">Coverage could not be read: {error}</p>
        )}

        {summary && (
          <div className="flex items-start gap-3 rounded-md border p-4">
            {healthy ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            ) : (
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            )}
            <div className="space-y-1 text-sm">
              <p className="font-medium">
                {rows.length === 0
                  ? "No foreign-currency activity yet"
                  : healthy
                    ? "Every currency in use has a current rate"
                    : `${gaps} ${gaps === 1 ? "currency needs" : "currencies need"} attention`}
              </p>
              <p className="text-muted-foreground">
                {summary.documents_before_coverage > 0
                  ? `${summary.documents_before_coverage} existing ${summary.documents_before_coverage === 1 ? "document is" : "documents are"} dated before the rate book starts.`
                  : "No document is dated before the rate book starts."}
              </p>
              <p className="text-muted-foreground">
                Platform snapshot{" "}
                {summary.provider_snapshot_as_of
                  ? `${new Date(summary.provider_snapshot_as_of).toLocaleDateString()} (${summary.provider_snapshot_age_days ?? 0} ${summary.provider_snapshot_age_days === 1 ? "day" : "days"} old)`
                  : "never received"}
                {" · "}
                last published{" "}
                {summary.last_published_at
                  ? new Date(summary.last_published_at).toLocaleString()
                  : "never"}
              </p>
            </div>
          </div>
        )}

        {rows.length > 0 && (
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Currency</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell">Used</TableHead>
                  <TableHead className="hidden md:table-cell">Coverage from</TableHead>
                  <TableHead className="hidden md:table-cell">Latest rate</TableHead>
                  <TableHead className="hidden lg:table-cell">Uncovered</TableHead>
                  {canEdit && <TableHead className="text-right">Action</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.currency}>
                    <TableCell className="font-medium">{row.currency}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(row.status)}>
                        {STATUS_LABEL[row.status] ?? row.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground">
                      {row.document_count} doc{row.document_count === 1 ? "" : "s"}
                      {row.first_used_on ? ` · from ${row.first_used_on}` : ""}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground">
                      {row.coverage_start ?? "—"}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {row.latest_rate != null ? (
                        <span>
                          {Number(row.latest_rate)}{" "}
                          <span className="text-muted-foreground">
                            ({row.latest_source ?? "—"}
                            {row.latest_rate_date ? `, ${row.latest_rate_date}` : ""})
                          </span>
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-muted-foreground">
                      {row.uncovered_documents || "—"}
                    </TableCell>
                    {canEdit && (
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onRecordRate(row.currency, gapDate(row))}
                        >
                          Record rate
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
