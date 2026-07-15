import { normalizeError } from "@/services/resilience";
/**
 * MyTimesheets — week + day view of the signed-in user's own time entries.
 * Manager approvals, project breakdown, and reports live on sibling routes.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { format, startOfWeek, endOfWeek, addWeeks, subWeeks, eachDayOfInterval, isSameDay } from "date-fns";
import { Plus, ChevronLeft, ChevronRight, Clock, Send, AlertCircle, CalendarDays, LayoutGrid } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { toast } from "sonner";

import { useTimesheets } from "@/hooks/timesheets";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useProjects } from "@/hooks/projects";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { WeeklyTimesheetGrid } from "@/components/timesheets/WeeklyTimesheetGrid";
import { TimesheetEntryForm } from "@/components/timesheets/TimesheetEntryForm";
import { TimesheetDayView } from "@/components/timesheets/TimesheetDayView";
import { getWeekStart, getWeeklyHoursTarget } from "@/lib/datetime/weekStart";
import { EmployeeLinkRequired } from "@/components/me/EmployeeLinkRequired";
import { ManagerTriageBanner } from "@/components/hr/ManagerTriageBanner";
import { KpiStrip } from "@/components/hr/KpiStrip";

export default function MyTimesheets() {
  const [searchParams] = useSearchParams();
  const { currentBusiness } = useBusinesses();
  const { currentOrg } = useOrganization();
  const weekStartsOn = getWeekStart(currentBusiness);
  const weeklyTarget = getWeeklyHoursTarget(currentBusiness);

  const [currentWeekStart, setCurrentWeekStart] = useState(() =>
    startOfWeek(new Date(), { weekStartsOn }),
  );
  const [view, setView] = useState<"week" | "day">("week");
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [showEntryForm, setShowEntryForm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Re-anchor week if business setting changes
  useEffect(() => {
    setCurrentWeekStart(startOfWeek(currentWeekStart, { weekStartsOn }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStartsOn]);

  useEffect(() => {
    if (searchParams.get("action") === "create" && !showEntryForm) {
      setSelectedDate(new Date());
      setShowEntryForm(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const weekEnd = endOfWeek(currentWeekStart, { weekStartsOn });
  const weekDays = eachDayOfInterval({ start: currentWeekStart, end: weekEnd });

  const { timesheets, submitTimesheets, deleteTimesheet, updateTimesheet, copyPreviousWeek, isLoading } = useTimesheets();
  const { currentEmployee } = useCurrentEmployee();
  const { projects } = useProjects();
  const [isCopying, setIsCopying] = useState(false);

  const weekTimesheets = useMemo(
    () => timesheets.filter((t) => {
      const d = new Date(t.date);
      return d >= currentWeekStart && d <= weekEnd;
    }),
    [timesheets, currentWeekStart, weekEnd],
  );
  const dayTimesheets = useMemo(
    () => weekTimesheets.filter((t) => isSameDay(new Date(t.date), selectedDate)),
    [weekTimesheets, selectedDate],
  );

  const totalHours = weekTimesheets.reduce((s, t) => s + (t.hours || 0), 0);
  const billableHours = weekTimesheets.filter((t) => t.is_billable).reduce((s, t) => s + (t.hours || 0), 0);
  const billablePct = totalHours > 0 ? Math.round((billableHours / totalHours) * 100) : 0;

  const exportConfig = (): ExportConfig => ({
    title: "My Timesheet",
    subtitle: `Week of ${format(currentWeekStart, "MMM d")} – ${format(weekEnd, "MMM d, yyyy")}`,
    companyName: currentOrg?.name || undefined,
    columns: [
      { key: "date", header: "Date", width: 14 },
      { key: "project", header: "Project", width: 22 },
      { key: "hours", header: "Hours", width: 8, format: "number", align: "right" },
      { key: "billable", header: "Billable", width: 10 },
      { key: "status", header: "Status", width: 12 },
      { key: "description", header: "Description", width: 30 },
    ],
    rows: weekTimesheets.map((t) => ({
      date: format(new Date(t.date), "yyyy-MM-dd"),
      project: (t as any).project?.name || "—",
      hours: t.hours || 0,
      billable: t.is_billable ? "Yes" : "No",
      status: t.status,
      description: t.description || "",
    })),
    sheetName: "Timesheet",
  });

  const handleSubmitWeek = async () => {
    if (!currentEmployee) {
      toast.error("Your account isn't linked to an HR record. Please contact your HR administrator.");
      return;
    }
    const drafts = weekTimesheets.filter((t) => t.status === "draft");
    if (drafts.length === 0) {
      toast.info("No draft entries to submit");
      return;
    }
    setIsSubmitting(true);
    try {
      await submitTimesheets(
        currentEmployee.id,
        format(currentWeekStart, "yyyy-MM-dd"),
        format(weekEnd, "yyyy-MM-dd"),
      );
    } catch (e: any) {
      toast.error(normalizeError(e).message || "Failed to submit week");
    } finally {
      setIsSubmitting(false);
    }
  };

  const openDay = (d: Date) => { setSelectedDate(d); setView("day"); };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  // Uniform empty state when the user is not yet linked to an employee
  // record (see EmployeeLinkRequired — server-authoritative gate).
  if (!currentEmployee && !isLoading) {
    return <EmployeeLinkRequired />;
  }

  return (
    <div className="space-y-6">
      <ManagerTriageBanner module="timesheets" />


      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My Timesheets</h1>
          <p className="text-sm text-muted-foreground">Track your working hours week by week.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ReportExportButtons getExportConfig={exportConfig} compact hideEmail />
          <Button
            variant="outline"
            disabled={!currentEmployee || isCopying}
            onClick={async () => {
              if (!currentEmployee) return;
              setIsCopying(true);
              try {
                const from = subWeeks(currentWeekStart, 1);
                await copyPreviousWeek(
                  currentEmployee.id,
                  format(from, "yyyy-MM-dd"),
                  format(currentWeekStart, "yyyy-MM-dd"),
                );
              } catch (e: any) {
                toast.error(normalizeError(e).message || "Failed to copy previous week");
              } finally {
                setIsCopying(false);
              }
            }}
          >
            {isCopying ? "Copying…" : "Copy previous week"}
          </Button>
          <Button variant="outline" onClick={handleSubmitWeek} disabled={isSubmitting || !currentEmployee}>
            <Send className="h-4 w-4 mr-2" /> Submit week
          </Button>
          <Button onClick={() => { setSelectedDate(view === "day" ? selectedDate : new Date()); setShowEntryForm(true); }}>
            <Plus className="h-4 w-4 mr-2" /> Add entry
          </Button>
        </div>
      </div>




      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => setCurrentWeekStart(subWeeks(currentWeekStart, 1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <h2 className="text-base sm:text-lg font-semibold">
            {format(currentWeekStart, "MMM d")} – {format(weekEnd, "MMM d, yyyy")}
          </h2>
          <Button variant="outline" size="icon" onClick={() => setCurrentWeekStart(addWeeks(currentWeekStart, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setCurrentWeekStart(startOfWeek(new Date(), { weekStartsOn }))}>
            This week
          </Button>
        </div>
        <ToggleGroup type="single" value={view} onValueChange={(v) => v && setView(v as any)}>
          <ToggleGroupItem value="week" aria-label="Week view"><LayoutGrid className="h-4 w-4 mr-1" />Week</ToggleGroupItem>
          <ToggleGroupItem value="day" aria-label="Day view"><CalendarDays className="h-4 w-4 mr-1" />Day</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-4">
        <StatCard label="This week" value={`${totalHours}h`} hint={`of ${weeklyTarget}h target`} />
        <StatCard label="Billable" value={`${billableHours}h`} hint={`${billablePct}% of total`} />
        <StatCard label="Entries" value={String(weekTimesheets.length)} />
        <StatCard label="Status" value={
          weekTimesheets.length === 0 ? "—" :
          weekTimesheets.every((t) => t.status === "approved") ? "Approved" :
          weekTimesheets.some((t) => t.status === "submitted") ? "Pending" : "Draft"
        } />
      </div>

      {view === "week" ? (
        <WeeklyTimesheetGrid
          weekDays={weekDays}
          timesheets={weekTimesheets}
          onAddEntry={(d) => { setSelectedDate(d); setShowEntryForm(true); }}
        />
      ) : (
        <TimesheetDayView
          weekDays={weekDays}
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
          entries={dayTimesheets}
          projects={projects}
          onAdd={() => setShowEntryForm(true)}
          onUpdate={(id, patch) => updateTimesheet(id, patch as any)}
          onDelete={(id) => deleteTimesheet(id)}
        />
      )}

      <TimesheetEntryForm open={showEntryForm} onOpenChange={setShowEntryForm} selectedDate={selectedDate} />
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-sm font-medium text-muted-foreground">{label}</div>
        <div className="text-2xl font-bold">{value}</div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}