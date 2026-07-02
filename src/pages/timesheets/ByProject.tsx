/**
 * ByProject — hours rolled up by project, with billable / invoiced / open
 * breakdown. Honors org+business+branch scope through the underlying hook.
 *
 * Invoice action only appears when the project has a customer and is billable;
 * the actual invoice creation is delegated to the invoicing module via the
 * existing flow (placeholder hand-off until that hook is exposed here).
 */
import { useMemo, useState } from "react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Receipt } from "lucide-react";
import { useTimesheets } from "@/hooks/timesheets";
import { useProjects } from "@/hooks/projects";
import { BillFromTimesheetsDialog } from "@/components/timesheets/BillFromTimesheetsDialog";

export default function TimesheetByProject() {
  const today = new Date();
  const [from, setFrom] = useState<string>(format(startOfMonth(today), "yyyy-MM-dd"));
  const [to, setTo] = useState<string>(format(endOfMonth(today), "yyyy-MM-dd"));
  const { timesheets, isLoading, refreshTimesheets } = useTimesheets();
  const { projects } = useProjects();
  const [billProject, setBillProject] = useState<{ projectId: string; contactId: string | null } | null>(null);

  const rows = useMemo(() => {
    const inRange = timesheets.filter((t) => t.date >= from && t.date <= to);
    const byProject = new Map<string, {
      project_id: string | null;
      name: string;
      total: number;
      billable: number;
      invoiced: number;
      approved: number;
    }>();
    for (const t of inRange) {
      const key = t.project_id || "__none__";
      const name =
        projects.find((p) => p.id === t.project_id)?.name ||
        (t.project_id ? "Unknown project" : "No project");
      const r = byProject.get(key) || {
        project_id: t.project_id,
        name,
        total: 0,
        billable: 0,
        invoiced: 0,
        approved: 0,
      };
      r.total += t.hours || 0;
      if (t.is_billable) r.billable += t.hours || 0;
      if (t.is_invoiced) r.invoiced += t.hours || 0;
      if (t.status === "approved") r.approved += t.hours || 0;
      byProject.set(key, r);
    }
    return Array.from(byProject.values()).sort((a, b) => b.total - a.total);
  }, [timesheets, projects, from, to]);

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
          <CardTitle className="text-base">{rows.length} projects</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">No entries in range.</div>
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
                  {rows.map((r) => {
                    const open = Math.max(r.billable - r.invoiced, 0);
                    const proj: any = projects.find((p) => p.id === r.project_id);
                    const canBill = open > 0 && proj?.is_billable && proj?.customer_id;
                    return (
                      <tr key={r.project_id ?? "none"} className="border-b last:border-b-0">
                        <td className="p-2 font-medium">{r.name}</td>
                        <td className="p-2 text-right">{r.total.toFixed(2)}h</td>
                        <td className="p-2 text-right">{r.approved.toFixed(2)}h</td>
                        <td className="p-2 text-right">{r.billable.toFixed(2)}h</td>
                        <td className="p-2 text-right">{r.invoiced.toFixed(2)}h</td>
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
                                setBillProject({ projectId: r.project_id!, contactId: proj.customer_id })
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
        onInvoiced={() => { setBillProject(null); refreshTimesheets(); }}
      />
    </div>
  );
}

