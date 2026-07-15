/**
 * MyLeave — self-service surface at /me/leave.
 *
 * Purpose-built portal page that mirrors the shape of /me/attendance and
 * /me/timesheets: sticky primary CTA, balance strip, request history.
 * Replaces the previous mount of the admin-flavoured LeaveDashboard under
 * /me/leave so portal users no longer see HR-only controls (settings dialog,
 * export buttons, team-calendar tab).
 *
 * Manager triage banner surfaces queued team approvals to anyone who
 * doubles as a line manager — same primitive as the other two ESS pages.
 */
import { useEffect, useState } from "react";
import { useDrillDownAnchor } from "@/hooks/payroll/useDrillDownAnchor";
import { format } from "date-fns";
import { CalendarOff, Plus, Inbox, CalendarClock, CheckCircle2, Hourglass, Wallet } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, PageBody } from "@/design-system";
import { KpiStrip } from "@/components/hr/KpiStrip";

import { ManagerTriageBanner } from "@/components/hr/ManagerTriageBanner";
import { LeaveRequestForm } from "@/components/leave/LeaveRequestForm";
import { LeaveBalanceCard } from "@/components/leave/LeaveBalanceCard";
import { useLeaveRequests } from "@/hooks/leave/useLeaveRequests";
import { useLeaveTypes } from "@/hooks/leave/useLeaveTypes";
import { useLeaveAllocations, type LeaveBalance } from "@/hooks/leave/useLeaveAllocations";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";

function statusBadge(status: string) {
  const map: Record<string, { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "bg-muted text-muted-foreground" },
    pending: { label: "Pending", cls: "bg-amber-500/10 text-amber-600 border-amber-500/20" },
    pending_second_approval: { label: "Awaiting final approval", cls: "bg-amber-500/10 text-amber-700 border-amber-500/20" },
    approved: { label: "Approved", cls: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20" },
    rejected: { label: "Rejected", cls: "bg-rose-500/10 text-rose-600 border-rose-500/20" },
    cancelled: { label: "Cancelled", cls: "bg-muted text-muted-foreground" },
  };
  const v = map[status] ?? { label: status, cls: "" };
  return (
    <Badge variant="outline" className={v.cls}>
      {v.label}
    </Badge>
  );
}

export default function MyLeave() {
  const { leaveRequests, isLoading } = useLeaveRequests();
  const { leaveTypes, isLoading: typesLoading } = useLeaveTypes();
  const { currentEmployee } = useCurrentEmployee();
  const { getEmployeeBalances } = useLeaveAllocations();
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [showRequestForm, setShowRequestForm] = useState(false);

  useEffect(() => {
    if (currentEmployee?.id) {
      getEmployeeBalances(currentEmployee.id).then(setBalances).catch(() => setBalances([]));
    }
  }, [currentEmployee?.id]);

  const pending = leaveRequests.filter((r) =>
    r.status === "pending" || r.status === "pending_second_approval",
  );
  const upcoming = leaveRequests.filter(
    (r) => r.status === "approved" && new Date(r.end_date) >= new Date(),
  );
  const history = leaveRequests
    .filter((r) => !pending.includes(r))
    .slice(0, 20);

  // Aggregate balance totals for the KPI strip. Days-based, matching the
  // per-type LeaveBalanceCard rows below (which still show per-type detail).
  const totals = balances.reduce(
    (acc, b) => {
      acc.allocated += Number(b.allocated) || 0;
      acc.used += Number(b.used) || 0;
      acc.pending += Number(b.pending) || 0;
      return acc;
    },
    { allocated: 0, used: 0, pending: 0 },
  );
  const remaining = Math.max(totals.allocated - totals.used - totals.pending, 0);

  return (
    <>
      <PageHeader
        title="My Time Off"
        description="Request leave, track approvals, and view your remaining balance."
        actions={
          <Button onClick={() => setShowRequestForm(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Request leave
          </Button>
        }
      />
      <PageBody>
        {/* Manager triage — same primitive used on /me/attendance and /me/timesheets */}
        <ManagerTriageBanner module="leave" />

      <KpiStrip
        tiles={[
          { key: "remaining", label: "Days remaining", value: remaining, icon: Wallet, tone: "emerald", hint: "across all leave types" },
          { key: "used", label: "Days used", value: totals.used, icon: CheckCircle2, tone: "neutral" },
          { key: "pending", label: "Pending", value: pending.length, icon: Hourglass, tone: pending.length ? "amber" : "neutral", hint: "requests awaiting approval" },
          { key: "upcoming", label: "Upcoming", value: upcoming.length, icon: CalendarClock, tone: "sky", hint: "approved & scheduled" },
        ]}
      />

      {/* Balances strip */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Your balances
        </h2>
        {typesLoading ? (
          <div className="text-sm text-muted-foreground">Loading balances…</div>
        ) : leaveTypes.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-8 text-center">
              <CalendarOff className="h-10 w-10 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">
                No leave types have been set up yet. Contact your administrator.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {leaveTypes.map((type) => {
              const b = balances.find((bal) => bal.leave_type_id === type.id);
              return (
                <LeaveBalanceCard
                  key={type.id}
                  leaveType={type}
                  allocated={b?.allocated ?? 0}
                  used={b?.used ?? 0}
                  pending={b?.pending ?? 0}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* Requests */}
      <Tabs defaultValue="upcoming" className="space-y-3">
        <TabsList>
          <TabsTrigger value="upcoming">
            Upcoming{upcoming.length > 0 ? ` (${upcoming.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="pending">
            Pending{pending.length > 0 ? ` (${pending.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="upcoming">
          <RequestList
            rows={upcoming}
            emptyTitle="No upcoming time off"
            emptyBody="Approved requests starting today or later will appear here."
          />
        </TabsContent>
        <TabsContent value="pending">
          <RequestList
            rows={pending}
            emptyTitle="Nothing waiting on approval"
            emptyBody="Requests you submit appear here until a manager decides on them."
          />
        </TabsContent>
        <TabsContent value="history">
          <RequestList
            rows={history}
            emptyTitle={isLoading ? "Loading…" : "No leave history yet"}
            emptyBody="Approved, rejected, and cancelled requests will appear here."
          />
        </TabsContent>
      </Tabs>

      <LeaveRequestForm open={showRequestForm} onOpenChange={setShowRequestForm} />
      </PageBody>
    </>
  );
}

function RequestList({
  rows,
  emptyTitle,
  emptyBody,
}: {
  rows: ReturnType<typeof useLeaveRequests>["leaveRequests"];
  emptyTitle: string;
  emptyBody: string;
}) {
  // Phase 4 P4 — destination of `/me/leave?request=…` drill-downs.
  const { getAnchorProps } = useDrillDownAnchor("request", { rowIdPrefix: "leave-request-" });
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-10 text-center">
          <Inbox className="h-9 w-9 text-muted-foreground mb-3" />
          <p className="text-sm font-medium">{emptyTitle}</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">{emptyBody}</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Requests</CardTitle>
        <CardDescription className="text-xs">
          {rows.length} {rows.length === 1 ? "request" : "requests"}
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        {rows.map((r) => {
          const anchor = getAnchorProps(r.id);
          return (
          <div
            key={r.id}
            id={anchor.id}
            data-anchor={anchor["data-anchor"]}
            className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-3 first:pt-0 last:pb-0 ${anchor.className}`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm truncate">
                  {r.leave_type?.name ?? "Leave"}
                </span>
                {statusBadge(r.status ?? "draft")}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {format(new Date(r.start_date), "MMM d, yyyy")} —{" "}
                {format(new Date(r.end_date), "MMM d, yyyy")} · {r.days_requested} day
                {r.days_requested === 1 ? "" : "s"}
              </div>
              {r.reason && (
                <p className="text-xs text-muted-foreground italic mt-1 line-clamp-1">
                  "{r.reason}"
                </p>
              )}
            </div>
          </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
