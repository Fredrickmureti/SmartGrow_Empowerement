/**
 * Roster Planner (Turn E) — weekly grid view to plan shift assignments
 * per employee per day. Lives at /hr/attendance/roster.
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useEmployees } from "@/hooks/useEmployees";
import { useShifts, useShiftAssignments } from "@/hooks/useShifts";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AttendanceFormShell } from "@/components/attendance/_shared/AttendanceFormShell";
import { WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { ChevronLeft, ChevronRight, Calendar, X } from "lucide-react";
import { Label } from "@/components/ui/label";
import { SavedViewMenu } from "@/components/hr/SavedViewMenu";
import { StatusFilterChips, type StatusChip } from "@/components/hr/StatusFilterChips";


function startOfWeek(d: Date) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // Monday start
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default function RosterPlanner() {
  const { employees } = useEmployees();
  const { shifts } = useShifts();
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [searchParams, setSearchParams] = useSearchParams();

  // URL-driven filters: status chip (draft/published/conflicts/mine) and
  // payroll run scope (?run_id=…). Both survive bookmarks/share-links.
  type StatusValue = "draft" | "published" | "conflicts" | "mine";
  const status = (searchParams.get("status") as StatusValue | null) ?? null;
  const runId = searchParams.get("run_id");
  const [activeViewId, setActiveViewId] = useState<string | null>(null);

  // Resolve the payroll run name so the chip surfaces a human label, not just an id.
  const { data: runRow } = useQuery({
    queryKey: ["payroll-run-name", runId],
    enabled: !!runId,
    staleTime: 60_000,
    queryFn: async () => {
      // payroll_runs has no `name` column; the human label is `payroll_number`
      // (e.g. "PR-2026-03"). Fall back to the run id slice when missing.
      const { data } = await supabase
        .from("payroll_runs")
        .select("id, payroll_number")
        .eq("id", runId!)
        .maybeSingle();
      return data as { id: string; payroll_number: string | null } | null;
    },
  });
  const runLabel = runRow?.payroll_number?.trim() || (runId ? `run ${runId.slice(0, 8)}` : "");


  const setStatus = (next: StatusValue | null) => {
    const sp = new URLSearchParams(searchParams);
    if (next) sp.set("status", next);
    else sp.delete("status");
    setSearchParams(sp, { replace: true });
  };
  const clearRunId = () => {
    const sp = new URLSearchParams(searchParams);
    sp.delete("run_id");
    setSearchParams(sp, { replace: true });
  };

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const from = ymd(days[0]);
  const to = ymd(days[6]);

  const { assignments, assign, remove, updateStatus } = useShiftAssignments({ from, to });

  const [dialog, setDialog] = useState<{
    open: boolean;
    employeeId?: string;
    date?: string;
  }>({ open: false });
  const [shiftId, setShiftId] = useState<string>("");

  // Group assignments by employee|date so we can detect overlap counts cheaply.
  const grid = useMemo(() => {
    const m = new Map<string, typeof assignments>();
    for (const a of assignments) {
      const key = `${a.employee_id}|${a.assignment_date}`;
      const arr = m.get(key) ?? [];
      arr.push(a);
      m.set(key, arr);
    }
    return m;
  }, [assignments]);

  // Apply chip filter to the assignments shown per cell (status filter only
  // hides cells' chips; "mine" / "conflicts" are derived locally).
  const filterCell = (cell: typeof assignments): typeof assignments => {
    if (!status) return cell;
    if (status === "draft") return cell.filter((a) => a.status === "planned");
    if (status === "published") return cell.filter((a) => a.status === "published");
    if (status === "conflicts") return cell.length > 1 ? cell : [];
    return cell;
  };

  const counts = useMemo(() => {
    let draft = 0, published = 0, conflicts = 0;
    for (const [, cell] of grid) {
      for (const a of cell) {
        if (a.status === "planned") draft += 1;
        else if (a.status === "published") published += 1;
      }
      if (cell.length > 1) conflicts += 1;
    }
    return { draft, published, conflicts };
  }, [grid]);

  const chips: StatusChip<StatusValue>[] = [
    { value: "draft", label: "Draft", count: counts.draft },
    { value: "published", label: "Published", count: counts.published, tone: "emerald" },
    { value: "conflicts", label: "Conflicts", count: counts.conflicts, tone: "rose" },
    { value: "mine", label: "Mine" },
  ];

  const activeEmployees = (employees ?? []).filter((e: any) => !e.termination_date);

  // Saved-view payload: only the bits we persist on disk.
  type SavedFilters = { status: StatusValue | null; run_id: string | null };
  const currentFilters: SavedFilters = { status, run_id: runId };
  const applyFilters = (f: SavedFilters) => {
    const sp = new URLSearchParams(searchParams);
    if (f.status) sp.set("status", f.status);
    else sp.delete("status");
    if (f.run_id) sp.set("run_id", f.run_id);
    else sp.delete("run_id");
    setSearchParams(sp, { replace: true });
  };


  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Calendar className="h-6 w-6" /> Roster Planner
          </h1>
          <p className="text-sm text-muted-foreground">
            Week of {days[0].toDateString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => setWeekStart(addDays(weekStart, -7))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>
            This week
          </Button>
          <Button variant="outline" size="icon" onClick={() => setWeekStart(addDays(weekStart, 7))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <StatusFilterChips chips={chips} active={status} onChange={setStatus} />
        <div className="flex items-center gap-2 flex-wrap">
          {runId && (
            <Badge variant="secondary" className="gap-1 pl-2 pr-1 py-1">
              <span className="text-[11px]">Scoped to: <span className="font-medium">{runLabel}</span></span>
              <button
                type="button"
                onClick={clearRunId}
                className="ml-1 rounded-sm hover:bg-muted-foreground/10"
                aria-label="Clear run filter"
                title="Clear run filter"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}

          <SavedViewMenu<SavedFilters>
            storageKey="hr.roster.views"
            currentFilters={currentFilters}
            onApply={applyFilters}
            activeViewId={activeViewId}
            onActiveViewIdChange={setActiveViewId}
          />
        </div>
      </div>

      <Card>

        <CardHeader>
          <CardTitle>Weekly roster</CardTitle>
          <CardDescription>
            Click any cell to assign a shift. Overlapping shifts on the same day are
            blocked automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <th className="text-left p-2 border-b sticky left-0 bg-background">
                  Employee
                </th>
                {days.map((d) => (
                  <th key={d.toISOString()} className="text-left p-2 border-b">
                    <div className="font-medium">
                      {d.toLocaleDateString(undefined, { weekday: "short" })}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activeEmployees.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-4 text-center text-muted-foreground">
                    No active employees in scope.
                  </td>
                </tr>
              )}
              {activeEmployees.map((emp: any) => (
                <tr key={emp.id}>
                  <td className="p-2 border-b sticky left-0 bg-background">
                    <div className="font-medium">
                      {emp.first_name} {emp.last_name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {emp.employee_number}
                    </div>
                  </td>
                  {days.map((d) => {
                    const key = `${emp.id}|${ymd(d)}`;
                    const cell = filterCell(grid.get(key) ?? []);
                    return (
                      <td
                        key={key}
                        className="p-1 border-b align-top min-w-[140px] cursor-pointer hover:bg-muted/40"
                        onClick={() => {
                          setDialog({ open: true, employeeId: emp.id, date: ymd(d) });
                          setShiftId("");
                        }}
                      >
                        {cell.map((a) => (
                          <div
                            key={a.id}
                            className="flex items-center justify-between rounded px-2 py-1 mb-1 text-xs"
                            style={{
                              backgroundColor: (a.shift?.color ?? "#3b82f6") + "22",
                              borderLeft: `3px solid ${a.shift?.color ?? "#3b82f6"}`,
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div>
                              <div className="font-medium">{a.shift?.name ?? "Shift"}</div>
                              <div className="text-[10px] text-muted-foreground">
                                {a.shift?.start_time?.slice(0, 5)}–
                                {a.shift?.end_time?.slice(0, 5)} · {a.status}
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              {a.status === "planned" && (
                                <button
                                  className="text-[10px] underline text-primary"
                                  onClick={() =>
                                    updateStatus.mutate({ id: a.id, status: "published" })
                                  }
                                >
                                  publish
                                </button>
                              )}
                              <button onClick={() => remove.mutate(a.id)}>
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <AttendanceFormShell
        open={dialog.open}
        onOpenChange={(o) => setDialog({ open: o })}
        entity="roster-assignment"
        busy={assign.isPending}
        submitLabel="Assign"
        submitDisabled={!shiftId || !dialog.employeeId || !dialog.date}
        onSubmit={async () => {
          if (!dialog.employeeId || !dialog.date) return;
          await assign.mutateAsync({
            employee_id: dialog.employeeId,
            shift_id: shiftId,
            assignment_date: dialog.date,
          });
          setDialog({ open: false });
        }}
      >
        <WorkflowSheetSection number={1} title="Shift" subtitle={`Date: ${dialog.date ?? "—"} · Overlaps will be rejected by the server.`}>
          <WorkflowField label="Shift" required>
            <Select value={shiftId} onValueChange={setShiftId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a shift" />
              </SelectTrigger>
              <SelectContent>
                {shifts
                  .filter((s) => s.is_active)
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} · {s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </WorkflowField>
        </WorkflowSheetSection>
      </AttendanceFormShell>
    </div>
  );
}
