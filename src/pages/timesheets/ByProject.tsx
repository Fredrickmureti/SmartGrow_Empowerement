/**
 * ByProject — hours rolled up by project.
 *
 * Wave 4: every number on this page comes from the canonical server metric
 * function get_timesheet_project_metrics (via useTimesheetMetrics). There is no
 * client-side grouping, no client-side billable/invoiced arithmetic and no
 * client-side invoice-eligibility rule — the server returns customer_id,
 * project_is_billable and uninvoiced_billable_hours, and the actual invoicing is
 * delegated to the invoice_project_timesheets RPC through the dialog.
 */
import { useState } from "react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Receipt } from "lucide-react";
import { useTimesheetMetrics } from "@/hooks/timesheets";
import { BillFromTimesheetsDialog } from "@/components/timesheets/BillFromTimesheetsDialog";

export default function TimesheetByProject() {
  const today = new Date();
  const [from, setFrom] = useState<string>(format(startOfMonth(today), "yyyy-MM-dd"));
  const [to, setTo] = useState<string>(format(endOfMonth(today), "yyyy-MM-dd"));
  const [billProject, setBillProject] = useState<{ projectId: string; contactId: string | null } | null>(
    null,
  );

  const { byProject, isLoading, refresh } = useTimesheetMetrics(from, to);

  return (
    <div className="space-y-4 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Timesheets by Project</h1>
        <p className="text-sm text-muted-foreground">
          Hours grouped by project. Use the date range to scope the view.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label className="text-xs">From</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs">To</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{byProject.length} projects</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : byProject.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No entries in range.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-muted-foreground border-b">
                  <tr>
                    <th className="text-left p-2">Project</th>
                    <th className="text-right p-2">Total</th>
                    <th className="text-right p-2">Approved</th>
                    <th className="text-right p-2">Billable</th>
                    <th className="text-right p-2">Invoiced</th>
                    <th className="text-right p-2">Open billable</th>
                    <th className="text-right p-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {byProject.map((r) => {
                    const open = r.uninvoiced_billable_hours;
                    const canBill = open > 0 && !!r.project_is_billable && !!r.customer_id && !!r.project_id;
                    return (
                      <tr key={r.project_id ?? "none"} className="border-b last:border-b-0">
                        <td className="p-2 font-medium">{r.project_name}</td>
                        <td className="p-2 text-right">{r.total_hours.toFixed(2)}h</td>
                        <td className="p-2 text-right">{r.approved_hours.toFixed(2)}h</td>
                        <td className="p-2 text-right">{r.billable_hours.toFixed(2)}h</td>
                        <td className="p-2 text-right">{r.invoiced_hours.toFixed(2)}h</td>
                        <td className="p-2 text-right">
                          {open > 0 ? (
                            <Badge variant="secondary">{open.toFixed(2)}h</Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="p-2 text-right">
                          {canBill && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setBillProject({
                                  projectId: r.project_id!,
                                  contactId: r.customer_id,
                                })
                              }
                            >
                              <Receipt className="h-3.5 w-3.5 mr-1" /> Invoice
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <BillFromTimesheetsDialog
        open={!!billProject}
        onOpenChange={(o) => !o && setBillProject(null)}
        projectId={billProject?.projectId ?? null}
        contactId={billProject?.contactId ?? null}
        onInvoiced={() => {
          setBillProject(null);
          refresh();
        }}
      />
    </div>
  );
}
