/**
 * TimesheetReports — Wave 4: every number on this screen comes from the
 * canonical server-side metric functions (see useTimesheetMetrics). There is no
 * metric arithmetic in this file: overtime thresholds, the week-start rule and
 * the exclusion of superseded (corrected) entries are all applied in the
 * database, so Reports, Payroll and Billing can never diverge.
 */
import { useState } from "react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTimesheetMetrics, useTimesheetReconciliation } from "@/hooks/timesheets";

const h = (v: number) => `${v.toFixed(2)}h`;

export default function TimesheetReports() {
  const today = new Date();
  const [from, setFrom] = useState(format(startOfMonth(today), "yyyy-MM-dd"));
  const [to, setTo] = useState(format(endOfMonth(today), "yyyy-MM-dd"));

  const { byEmployee, summary, uninvoiced, isLoading, error } = useTimesheetMetrics(from, to);
  const reconciliation = useTimesheetReconciliation(from, to);
  const employeeName = (id: string) =>
    byEmployee.find((e) => e.employee_id === id)?.employee_name ?? id.slice(0, 8);

  return (
    <div className="space-y-4 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Timesheet Reports</h1>
        <p className="text-sm text-muted-foreground">
          Canonical hours from the server — one definition shared with Payroll and Billing.
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

      {error && (
        <Card>
          <CardContent className="py-4 text-sm text-destructive">
            Could not load timesheet metrics: {(error as Error).message}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total hours" value={h(summary.total_hours)} />
        <Stat label="Approved hours" value={h(summary.approved_hours)} />
        <Stat label="Overtime hours" value={h(summary.overtime_hours)} />
        <Stat label="Utilisation" value={`${summary.utilization_pct.toFixed(2)}%`} />
      </div>

      <Tabs defaultValue="employee" className="w-full">
        <TabsList>
          <TabsTrigger value="employee">By Employee</TabsTrigger>
          <TabsTrigger value="billable">Billable</TabsTrigger>
          <TabsTrigger value="overtime">Overtime</TabsTrigger>
          <TabsTrigger value="payroll">Payroll-Ready</TabsTrigger>
          <TabsTrigger value="uninvoiced">Uninvoiced</TabsTrigger>
          <TabsTrigger value="reconciliation">Attendance vs Timesheet</TabsTrigger>
        </TabsList>

        <TabsContent value="employee">
          <ReportTable
            loading={isLoading}
            headers={["Employee", "Total", "Approved", "Billable", "Non-billable", "Utilisation"]}
            rows={byEmployee.map((r) => [
              r.employee_name,
              h(r.total_hours),
              h(r.approved_hours),
              h(r.billable_hours),
              h(r.non_billable_hours),
              `${r.utilization_pct.toFixed(2)}%`,
            ])}
          />
        </TabsContent>

        <TabsContent value="billable">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Billable split</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Total" value={h(summary.total_hours)} />
              <Stat label="Billable" value={h(summary.billable_hours)} />
              <Stat label="Non-billable" value={h(summary.non_billable_hours)} />
              <Stat label="Open billable" value={h(summary.uninvoiced_billable_hours)} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="overtime">
          <ReportTable
            loading={isLoading}
            headers={["Employee", "Total", "Overtime"]}
            rows={byEmployee
              .filter((r) => r.overtime_hours > 0)
              .map((r) => [r.employee_name, h(r.total_hours), h(r.overtime_hours)])}
          />
        </TabsContent>

        <TabsContent value="payroll">
          <ReportTable
            loading={isLoading}
            headers={["Employee", "Approved hours", "Locked for payroll"]}
            rows={byEmployee.map((r) => [
              r.employee_name,
              h(r.approved_hours),
              h(r.payroll_locked_hours),
            ])}
          />
        </TabsContent>

        <TabsContent value="uninvoiced">
          <ReportTable
            loading={isLoading}
            headers={["Date", "Employee", "Project", "Hours", "Amount"]}
            rows={uninvoiced.map((r) => [
              r.date,
              r.employee_name,
              r.project_name,
              h(r.hours),
              r.billing_amount != null ? r.billing_amount.toFixed(2) : "—",
            ])}
          />
        </TabsContent>

        <TabsContent value="reconciliation" className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Attendance records presence; timesheets record worked, attributed time. They are
            separate facts — these are the days where they disagree by more than 15 minutes.
          </p>
          {reconciliation.error && (
            <Card>
              <CardContent className="py-4 text-sm text-destructive">
                Could not load reconciliation: {(reconciliation.error as Error).message}
              </CardContent>
            </Card>
          )}
          <ReportTable
            loading={reconciliation.isLoading}
            headers={["Day", "Employee", "Attended", "Recorded", "Approved", "Variance"]}
            rows={reconciliation.mismatches.map((r) => [
              r.day,
              employeeName(r.employee_id),
              h(r.attended_hours),
              h(r.recorded_hours),
              h(r.approved_hours),
              `${r.variance_hours > 0 ? "+" : ""}${r.variance_hours.toFixed(2)}h`,
            ])}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ReportTable({
  headers,
  rows,
  loading,
}: {
  headers: string[];
  rows: (string | number)[][];
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">No data in range.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-muted-foreground border-b">
                <tr>
                  {headers.map((head) => (
                    <th key={head} className="text-left p-2">
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b last:border-b-0">
                    {r.map((c, j) => (
                      <td key={j} className="p-2">
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}
