/**
 * TimesheetReports — built-in reports computed from the existing org/business
 * scoped timesheet rows. Reads only; no hardcoded data.
 *
 * Reports:
 *   • Hours by employee
 *   • Billable vs non-billable
 *   • Overtime (per the daily threshold from timesheet_settings)
 *   • Payroll-ready (approved hours)
 *   • Uninvoiced billable
 */
import { useMemo, useState } from "react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTimesheets, useTimesheetSettings } from "@/hooks/timesheets";

export default function TimesheetReports() {
  const today = new Date();
  const [from, setFrom] = useState(format(startOfMonth(today), "yyyy-MM-dd"));
  const [to, setTo] = useState(format(endOfMonth(today), "yyyy-MM-dd"));
  const { timesheets } = useTimesheets();
  const { settings } = useTimesheetSettings();

  const rows = useMemo(
    () => timesheets.filter((t) => t.date >= from && t.date <= to),
    [timesheets, from, to],
  );

  const byEmployee = useMemo(() => {
    const m = new Map<string, { name: string; total: number; billable: number; approved: number }>();
    for (const t of rows) {
      const e = t.employee;
      const name = e ? `${e.first_name} ${e.last_name}` : "Unknown";
      const r = m.get(t.employee_id) || { name, total: 0, billable: 0, approved: 0 };
      r.total += t.hours || 0;
      if (t.is_billable) r.billable += t.hours || 0;
      if (t.status === "approved") r.approved += t.hours || 0;
      m.set(t.employee_id, r);
    }
    return Array.from(m.values()).sort((a, b) => b.total - a.total);
  }, [rows]);

  const billableSplit = useMemo(() => {
    const total = rows.reduce((s, t) => s + (t.hours || 0), 0);
    const billable = rows.filter((t) => t.is_billable).reduce((s, t) => s + (t.hours || 0), 0);
    return { total, billable, nonBillable: total - billable };
  }, [rows]);

  const overtime = useMemo(() => {
    const threshold = settings?.overtime_threshold_daily ?? 8;
    const m = new Map<string, { name: string; overtime: number }>();
    const byEmpDate = new Map<string, number>();
    for (const t of rows) {
      const k = `${t.employee_id}|${t.date}`;
      byEmpDate.set(k, (byEmpDate.get(k) || 0) + (t.hours || 0));
    }
    for (const [k, hrs] of byEmpDate) {
      if (hrs > threshold) {
        const [empId] = k.split("|");
        const name =
          rows.find((r) => r.employee_id === empId)?.employee?.first_name ?? "Unknown";
        const r = m.get(empId) || { name, overtime: 0 };
        r.overtime += hrs - threshold;
        m.set(empId, r);
      }
    }
    return { threshold, rows: Array.from(m.values()) };
  }, [rows, settings]);

  const payrollReady = useMemo(
    () =>
      byEmployee.map((r) => ({
        name: r.name,
        approved: r.approved,
        locked: rows
          .filter((t) => t.status === "approved" && (t as any).payroll_locked)
          .reduce((s, t) => s + (t.hours || 0), 0),
      })),
    [byEmployee, rows],
  );

  const uninvoiced = rows.filter((t) => t.is_billable && !t.is_invoiced && t.status === "approved");

  return (
    <div className="space-y-4 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Timesheet Reports</h1>
        <p className="text-sm text-muted-foreground">
          Built from real timesheet data — no hardcoded values.
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

      <Tabs defaultValue="employee" className="w-full">
        <TabsList>
          <TabsTrigger value="employee">By Employee</TabsTrigger>
          <TabsTrigger value="billable">Billable</TabsTrigger>
          <TabsTrigger value="overtime">Overtime</TabsTrigger>
          <TabsTrigger value="payroll">Payroll-Ready</TabsTrigger>
          <TabsTrigger value="uninvoiced">Uninvoiced</TabsTrigger>
        </TabsList>

        <TabsContent value="employee">
          <ReportTable
            headers={["Employee", "Total", "Approved", "Billable"]}
            rows={byEmployee.map((r) => [r.name, `${r.total.toFixed(2)}h`, `${r.approved.toFixed(2)}h`, `${r.billable.toFixed(2)}h`])}
          />
        </TabsContent>

        <TabsContent value="billable">
          <Card>
            <CardHeader><CardTitle className="text-base">Billable split</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-3 gap-4">
              <Stat label="Total" value={`${billableSplit.total.toFixed(2)}h`} />
              <Stat label="Billable" value={`${billableSplit.billable.toFixed(2)}h`} />
              <Stat label="Non-billable" value={`${billableSplit.nonBillable.toFixed(2)}h`} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="overtime">
          <ReportTable
            headers={["Employee", `Overtime (> ${overtime.threshold}h/day)`]}
            rows={overtime.rows.map((r) => [r.name, `${r.overtime.toFixed(2)}h`])}
          />
        </TabsContent>

        <TabsContent value="payroll">
          <ReportTable
            headers={["Employee", "Approved hours", "Locked for payroll"]}
            rows={payrollReady.map((r) => [r.name, `${r.approved.toFixed(2)}h`, `${r.locked.toFixed(2)}h`])}
          />
        </TabsContent>

        <TabsContent value="uninvoiced">
          <ReportTable
            headers={["Date", "Employee", "Hours", "Amount"]}
            rows={uninvoiced.map((t) => [
              t.date,
              t.employee ? `${t.employee.first_name} ${t.employee.last_name}` : "—",
              `${t.hours}h`,
              t.billing_amount != null ? t.billing_amount.toFixed(2) : "—",
            ])}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ReportTable({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  return (
    <Card>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">No data in range.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-muted-foreground border-b">
                <tr>{headers.map((h) => <th key={h} className="text-left p-2">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b last:border-b-0">
                    {r.map((c, j) => <td key={j} className="p-2">{c as any}</td>)}
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
