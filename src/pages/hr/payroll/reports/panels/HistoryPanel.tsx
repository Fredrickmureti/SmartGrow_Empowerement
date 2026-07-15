/**
 * HistoryPanel — reads `payroll_report_runs` for the current org/business,
 * most-recent first. Each row deep-links back into the viewer so
 * re-running a past generation is one click.
 */
import { Link } from "react-router-dom";
import { format } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePayrollReportRuns } from "@/hooks/payroll/usePayrollReportRuns";
import { OWNER_LABEL } from "@/hooks/payroll/usePayrollReportDefinitions";

export function HistoryPanel() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { data, isLoading } = usePayrollReportRuns({
    organizationId: currentOrg?.id ?? null,
    businessId: currentBusiness?.id ?? null,
    limit: 100,
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          Loading report history…
        </CardContent>
      </Card>
    );
  }

  if (!data || data.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          No report generations yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Report</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead className="text-right">Rows</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Generated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Link
                    to={`/hr/payroll/reports/${r.reportKey}`}
                    className="font-medium hover:underline"
                  >
                    {r.reportLabel ?? r.reportKey}
                  </Link>
                </TableCell>
                <TableCell>
                  {r.ownerKind ? (
                    <Badge variant="outline" className="text-[10px] font-normal">
                      {OWNER_LABEL[r.ownerKind as keyof typeof OWNER_LABEL] ??
                        r.ownerKind}
                    </Badge>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.rowCount ?? "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.durationMs != null ? `${r.durationMs} ms` : "—"}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={r.status === "succeeded" ? "outline" : "destructive"}
                    className="text-[10px] font-normal"
                  >
                    {r.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {format(new Date(r.generatedAt), "MMM d, yyyy · HH:mm")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default HistoryPanel;
