/**
 * OverviewPanel — landing dashboard rail.
 *
 * The KPI strip is rendered above this panel by the Reporting Centre.
 * This panel adds:
 *   • the most recent report generations (from `payroll_report_runs`)
 *   • quick links into the highest-traffic reports
 *
 * It intentionally does not run any reports. Users pick one and open it.
 */
import { Link } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowRight, Clock } from "lucide-react";

import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  usePayrollReportDefinitions,
  OWNER_LABEL,
} from "@/hooks/payroll/usePayrollReportDefinitions";
import { usePayrollReportRuns } from "@/hooks/payroll/usePayrollReportRuns";

const QUICK_KEYS = [
  "payroll_register",
  "payroll_summary",
  "employer_contributions",
  "statutory_liabilities",
];

export function OverviewPanel() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { data: defs } = usePayrollReportDefinitions(
    currentOrg?.id ?? null,
    currentBusiness?.id ?? null,
  );
  const { data: runs } = usePayrollReportRuns({
    organizationId: currentOrg?.id ?? null,
    businessId: currentBusiness?.id ?? null,
    limit: 6,
  });

  const quick =
    defs?.filter((d) => QUICK_KEYS.includes(d.reportKey)) ?? [];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Recent report generations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {runs && runs.length > 0 ? (
            runs.map((r) => (
              <Link
                key={r.id}
                to={`/hr/payroll/reports/${r.reportKey}`}
                className="flex items-center justify-between rounded-md border p-2 text-sm hover:bg-muted/50"
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">
                    {r.reportLabel ?? r.reportKey}
                  </div>
                  <div className="text-xs text-muted-foreground flex items-center gap-2">
                    <Clock className="h-3 w-3" />
                    {formatDistanceToNow(new Date(r.generatedAt), {
                      addSuffix: true,
                    })}
                    {r.rowCount != null && <span>· {r.rowCount} rows</span>}
                  </div>
                </div>
                <div className="ml-3 flex items-center gap-2 shrink-0">
                  {r.ownerKind && (
                    <Badge variant="outline" className="text-[10px]">
                      {OWNER_LABEL[
                        r.ownerKind as keyof typeof OWNER_LABEL
                      ] ?? r.ownerKind}
                    </Badge>
                  )}
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                </div>
              </Link>
            ))
          ) : (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No reports generated yet. Open a report from the Library tab.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick access</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {quick.map((d) => (
            <Button
              key={d.reportKey}
              variant="outline"
              className="w-full justify-between"
              asChild
            >
              <Link to={`/hr/payroll/reports/${d.reportKey}`}>
                {d.label}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          ))}
          {quick.length === 0 && (
            <div className="text-sm text-muted-foreground">
              No core reports available.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default OverviewPanel;
