/**
 * TeamTimesheets — manager / HR / admin view of submitted & approved timesheets
 * for the people they're allowed to see (direct reports / branch / org).
 *
 * Heavy lifting (scope filtering) is in `useTeamTimesheets`; this page renders
 * the list with status filters and a drill-in to the audit trail.
 */
import { useMemo, useState } from "react";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Lock, ClipboardCheck, CheckCircle2, XCircle, Clock4 } from "lucide-react";
import { useTeamTimesheets } from "@/hooks/timesheets";
import { KpiStrip, type KpiTile } from "@/components/hr/KpiStrip";

type StatusFilter = "all" | "submitted" | "approved" | "rejected";

export default function TeamTimesheets() {
  const { teamSubmissions, isLoading, canApproveTimesheets, canViewTeamTimesheets, isManager } =
    useTeamTimesheets();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");

  const allowed = canApproveTimesheets || canViewTeamTimesheets || isManager;

  const filtered = useMemo(() => {
    let rows = teamSubmissions;
    if (status !== "all") rows = rows.filter((r) => r.status === status);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (r) =>
          `${r.employee?.first_name ?? ""} ${r.employee?.last_name ?? ""}`.toLowerCase().includes(q) ||
          (r.employee?.employee_number ?? "").toLowerCase().includes(q),
      );
    }
    return rows;
  }, [teamSubmissions, status, search]);

  if (!allowed) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <Lock className="h-8 w-8 text-muted-foreground mb-3" />
          <h3 className="font-semibold">Manager access required</h3>
          <p className="text-sm text-muted-foreground mt-1">
            You need manager, HR, or admin rights to view team timesheets.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Team Timesheets</h1>
        <p className="text-sm text-muted-foreground">
          All submissions from people in your scope. Use Approvals to act on pending ones.
        </p>
      </div>

      <KpiStrip
        tiles={[
          { key: "pending", label: "Pending", value: teamSubmissions.filter((r) => r.status === "submitted").length, icon: ClipboardCheck, tone: "amber", active: status === "submitted", onClick: () => setStatus("submitted") },
          { key: "approved", label: "Approved", value: teamSubmissions.filter((r) => r.status === "approved").length, icon: CheckCircle2, tone: "emerald", active: status === "approved", onClick: () => setStatus("approved") },
          { key: "rejected", label: "Rejected", value: teamSubmissions.filter((r) => r.status === "rejected").length, icon: XCircle, tone: "rose", active: status === "rejected", onClick: () => setStatus("rejected") },
          { key: "all", label: "All in scope", value: teamSubmissions.length, icon: Clock4, tone: "neutral", active: status === "all", onClick: () => setStatus("all") },
        ] satisfies KpiTile[]}
      />


      <div className="flex flex-col sm:flex-row gap-2">
        <Input
          placeholder="Search employee or number…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-sm"
        />
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="sm:w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="submitted">Pending</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{filtered.length} submissions</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">No submissions match.</div>
          ) : (
            <div className="space-y-2">
              {filtered.map((s) => (
                <div
                  key={s.id}
                  className="grid grid-cols-1 md:grid-cols-[2fr_2fr_1fr_1fr_auto] gap-2 items-center rounded-md border p-3 text-sm"
                >
                  <div className="font-medium">
                    {s.employee?.first_name} {s.employee?.last_name}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {s.employee?.employee_number}
                    </span>
                  </div>
                  <div className="text-muted-foreground">
                    {format(new Date(s.period_start), "MMM d")} – {format(new Date(s.period_end), "MMM d, yyyy")}
                  </div>
                  <div>
                    {s.total_hours}h <span className="text-muted-foreground">total</span>
                  </div>
                  <div>
                    {s.billable_hours}h <span className="text-muted-foreground">billable</span>
                  </div>
                  <Badge
                    variant={
                      s.status === "approved" ? "default" : s.status === "rejected" ? "destructive" : "secondary"
                    }
                  >
                    {s.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
