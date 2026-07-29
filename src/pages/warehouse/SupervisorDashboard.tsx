/**
 * Supervisor Control Tower — Phase 4 §6.
 *
 * Labour view: the open task queue with SLA breach, unassigned work, and
 * per-assignee productivity for tasks completed today (earned vs actual
 * seconds, stamped server-side by `_wms_stamp_labour_metrics`).
 *
 * Reads `wms_tasks` under the `wms_tasks` query-key prefix so the WMS
 * realtime channel refreshes the board as operators claim and complete.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { PageHeader, PageBody, Section, LoadingState } from "@/design-system";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ClipboardList, UserX, AlarmClock, Gauge } from "lucide-react";
import { StateBreakdown, MetricTile } from "@/features/warehouse/dashboards/DashboardPrimitives";

const OPEN_STATES = ["pending", "available", "claimed", "in_progress"] as const;

export default function SupervisorDashboard() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const openTasks = useQuery({
    queryKey: ["wms_tasks", "supervisor-dashboard-open", businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_tasks")
        .select("id, task_type, state, priority, sla_at, assignee_user_id, expires_at")
        .eq("business_id", businessId!)
        .in("state", OPEN_STATES)
        .limit(1000);
      if (error) throw error;
      return data ?? [];
    },
  });

  const doneToday = useQuery({
    queryKey: ["wms_tasks", "supervisor-dashboard-done", businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      const { data, error } = await supabase
        .from("wms_tasks")
        .select("id, task_type, assignee_user_id, earned_seconds, actual_seconds, completed_at")
        .eq("business_id", businessId!)
        .gte("completed_at", midnight.toISOString())
        .limit(2000);
      if (error) throw error;
      return data ?? [];
    },
  });

  const loading = openTasks.isLoading || doneToday.isLoading;
  const open = openTasks.data ?? [];
  const done = doneToday.data ?? [];
  const now = Date.now();
  const breached = open.filter((t) => t.sla_at && new Date(t.sla_at as string).getTime() < now);
  const unassigned = open.filter((t) => !t.assignee_user_id);
  const staleLease = open.filter(
    (t) => t.expires_at && new Date(t.expires_at as string).getTime() < now,
  );

  const byOperator = new Map<
    string,
    { tasks: number; earned: number; actual: number }
  >();
  for (const t of done) {
    const key = String(t.assignee_user_id ?? "unassigned");
    const row = byOperator.get(key) ?? { tasks: 0, earned: 0, actual: 0 };
    row.tasks += 1;
    row.earned += Number(t.earned_seconds ?? 0);
    row.actual += Number(t.actual_seconds ?? 0);
    byOperator.set(key, row);
  }
  const operators = [...byOperator.entries()].sort((a, b) => b[1].tasks - a[1].tasks);

  return (
    <>
      <PageHeader
        title="Supervisor control tower"
        description="Open labour queue, SLA breach and today's operator productivity."
        actions={
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link to="/warehouse-app/tasks">Task queue</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/warehouse-app/labour">
                <Gauge className="mr-2 h-4 w-4" /> Labour standards
              </Link>
            </Button>
          </div>
        }
      />
      <PageBody>
        {loading ? (
          <LoadingState />
        ) : (
          <>
            <Section>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <MetricTile label="Open tasks" value={open.length} icon={ClipboardList} to="/warehouse-app/tasks" />
                <MetricTile
                  label="SLA breached"
                  value={breached.length}
                  tone={breached.length > 0 ? "bad" : "ok"}
                  sub="past sla_at"
                  icon={AlarmClock}
                />
                <MetricTile
                  label="Unassigned"
                  value={unassigned.length}
                  tone={unassigned.length > 0 ? "warn" : "ok"}
                  icon={UserX}
                />
                <MetricTile
                  label="Expired leases"
                  value={staleLease.length}
                  tone={staleLease.length > 0 ? "warn" : "ok"}
                  sub="eligible for reap"
                  icon={AlarmClock}
                />
              </div>
            </Section>

            <Section title="Open queue by task type">
              <Card><CardContent className="p-4"><StateBreakdown rows={open} field="task_type" /></CardContent></Card>
            </Section>

            <Section title="Open queue by state">
              <Card><CardContent className="p-4"><StateBreakdown rows={open} /></CardContent></Card>
            </Section>

            <Section
              title="Productivity today"
              description="Earned vs actual seconds on tasks completed since midnight."
            >
              <Card>
                <CardContent className="p-0">
                  {operators.length === 0 ? (
                    <p className="p-4 text-sm text-muted-foreground">No tasks completed yet today.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Operator</TableHead>
                          <TableHead className="text-right">Tasks</TableHead>
                          <TableHead className="text-right">Earned (s)</TableHead>
                          <TableHead className="text-right">Actual (s)</TableHead>
                          <TableHead className="text-right">Utilisation</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {operators.map(([id, r]) => (
                          <TableRow key={id}>
                            <TableCell className="font-mono text-xs">{id.slice(0, 8)}</TableCell>
                            <TableCell className="text-right font-mono">{r.tasks}</TableCell>
                            <TableCell className="text-right font-mono">{Math.round(r.earned)}</TableCell>
                            <TableCell className="text-right font-mono">{Math.round(r.actual)}</TableCell>
                            <TableCell className="text-right font-mono">
                              {r.actual > 0 ? `${Math.round((r.earned / r.actual) * 100)}%` : "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </Section>
          </>
        )}
      </PageBody>
    </>
  );
}
