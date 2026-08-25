/**
 * TimesheetEntryForm — settings-aware time entry.
 *
 * Server-truth honored:
 *   • `timesheet_settings.require_project / require_task / default_billable /
 *     min/max_hours_per_day / block_on_time_off_overlap`
 *   • `projects.allow_timesheets / is_billable / customer_id`
 *   • `project_billing_rate_preview` — the applicable billing rate is asked
 *     of the single server-side engine (`resolve_project_billing_rate`);
 *     this form never mirrors the rate precedence chain client-side.
 *   • `timesheets_billing` trigger — billable rows MUST have a billable
 *     project with a positive rate, so we mirror that rule client-side
 *     before submit so the user sees a friendly message instead of a 500.
 *   • `timesheets_employee_active` trigger — we don't try to bypass it; we
 *     just surface its message verbatim.
 *
 * UI: standardised on the `WorkflowSheet` enterprise pattern (Pass 3 of the
 * HR design-system standardisation effort). Sectioned, responsive, sticky
 * footer.
 */
import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CalendarIcon, AlertCircle } from "lucide-react";
import { format } from "date-fns";
import { cn, formatCurrency } from "@/lib/utils";
import {
  WorkflowSheet,
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { useTimesheets, useTimesheetSettings } from "@/hooks/timesheets";
import { useProjects } from "@/hooks/projects";
import { useProjectTasks } from "@/hooks/projects/useProjectTasks";
import { useProjectBillingRate } from "@/hooks/projects/useProjectBillingRate";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useAuth } from "@/contexts/AuthContext";
import { useBusinesses } from "@/hooks/useBusinesses";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface TimesheetEntryFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDate?: Date | null;
}

const NONE = "__none__";

export function TimesheetEntryForm({ open, onOpenChange, selectedDate }: TimesheetEntryFormProps) {
  const { createTimesheet, timesheets } = useTimesheets();
  const { settings } = useTimesheetSettings();
  const { projects } = useProjects();
  const { currentEmployee, isLoading: empLoading } = useCurrentEmployee();
  const { user } = useAuth();
  const { currentBusiness } = useBusinesses();

  const [date, setDate] = useState<Date | undefined>(selectedDate || new Date());
  const [projectId, setProjectId] = useState(NONE);
  const [taskId, setTaskId] = useState(NONE);
  const [hours, setHours] = useState("");
  const [description, setDescription] = useState("");
  const [isBillable, setIsBillable] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [timeOffOverlap, setTimeOffOverlap] = useState(false);

  const { tasks } = useProjectTasks(projectId !== NONE ? projectId : undefined);

  const eligibleProjects = useMemo(
    () => projects.filter((p: any) => p.allow_timesheets !== false),
    [projects],
  );

  const selectedProject = useMemo(
    () => eligibleProjects.find((p: any) => p.id === projectId),
    [eligibleProjects, projectId],
  );

  // Server-resolved rate for this project + this employee (single engine).
  const { rate: resolvedRate, isLoading: rateLoading } = useProjectBillingRate(
    projectId !== NONE ? projectId : null,
    currentEmployee?.id ?? null,
  );

  useEffect(() => { if (selectedDate) setDate(selectedDate); }, [selectedDate]);
  useEffect(() => { setTaskId(NONE); }, [projectId]);

  useEffect(() => {
    if (!settings) return;
    if (selectedProject) {
      setIsBillable(Boolean(selectedProject.is_billable && settings.default_billable));
    } else {
      setIsBillable(false);
    }
  }, [selectedProject?.id, settings?.default_billable]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setTimeOffOverlap(false);
      if (!settings?.block_on_time_off_overlap || !currentEmployee || !date) return;
      const iso = format(date, "yyyy-MM-dd");
      const { data } = await (supabase as any)
        .from("leave_requests")
        .select("id")
        .eq("employee_id", currentEmployee.id)
        .eq("status", "approved")
        .lte("start_date", iso)
        .gte("end_date", iso)
        .limit(1);
      if (!cancelled) setTimeOffOverlap((data?.length ?? 0) > 0);
    })();
    return () => { cancelled = true; };
  }, [settings?.block_on_time_off_overlap, currentEmployee?.id, date]);

  const sameDayHours = useMemo(() => {
    if (!date || !currentEmployee) return 0;
    const iso = format(date, "yyyy-MM-dd");
    return timesheets
      .filter((t) => t.employee_id === currentEmployee.id && t.date === iso)
      .reduce((s, t) => s + (t.hours || 0), 0);
  }, [timesheets, date, currentEmployee?.id]);

  const recentPicks = useMemo(() => {
    const seen = new Map<string, { project_id: string | null; task_id: string | null; description: string | null; is_billable: boolean; project_name?: string; task_name?: string }>();
    for (const t of timesheets.slice(0, 30)) {
      const key = `${t.project_id || ""}|${t.task_id || ""}|${t.description || ""}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        project_id: t.project_id,
        task_id: t.task_id,
        description: t.description,
        is_billable: !!t.is_billable,
        project_name: (t as any).project?.name,
        task_name: (t as any).task?.name,
      });
      if (seen.size >= 3) break;
    }
    return Array.from(seen.values());
  }, [timesheets]);

  const applyPick = (p: typeof recentPicks[number]) => {
    setProjectId(p.project_id || NONE);
    setTimeout(() => setTaskId(p.task_id || NONE), 0);
    setDescription(p.description || "");
    setIsBillable(p.is_billable);
  };

  const billableDisabledReason = (() => {
    if (!selectedProject) return "Pick a billable project to mark this entry as billable.";
    if (!selectedProject.is_billable) return "This project is non-billable.";
    if (rateLoading) return null;
    if (!resolvedRate || resolvedRate <= 0)
      return "No billing rate applies to you on this project.";
    return null;
  })();

  const validate = (): string | null => {
    if (!date) return "Pick a date.";
    if (!hours) return "Enter hours.";
    const n = parseFloat(hours);
    if (!Number.isFinite(n) || n <= 0) return "Hours must be positive.";
    if (settings?.require_project && projectId === NONE) return "A project is required by your org settings.";
    if (settings?.require_task && taskId === NONE) return "A task is required by your org settings.";
    const minH = settings?.minimum_hours_per_day ?? null;
    const maxH = settings?.maximum_hours_per_day ?? null;
    const dayTotal = sameDayHours + n;
    if (maxH != null && dayTotal > maxH)
      return `Day would total ${dayTotal}h — exceeds the ${maxH}h daily maximum.`;
    if (minH != null && dayTotal < minH)
      console.info(`Day under min (${dayTotal}/${minH}h)`);
    if (isBillable && billableDisabledReason)
      return `Cannot mark billable: ${billableDisabledReason}`;
    if (timeOffOverlap)
      return "You have approved time off on this date — entry blocked by org settings.";
    return null;
  };

  const resetForm = () => {
    setProjectId(NONE);
    setTaskId(NONE);
    setHours("");
    setDescription("");
    setIsBillable(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentEmployee) {
      toast.error("Your account isn't linked to an HR record. Please contact your HR administrator.");
      return;
    }
    const err = validate();
    if (err) { toast.error(err); return; }

    setIsSubmitting(true);
    try {
      await createTimesheet({
        date: format(date!, "yyyy-MM-dd"),
        employee_id: currentEmployee.id,
        business_id: currentBusiness?.id || null,
        project_id: projectId !== NONE ? projectId : null,
        task_id: taskId !== NONE ? taskId : null,
        hours: parseFloat(hours),
        description: description || null,
        is_billable: isBillable,
        billing_rate: null,
        billing_amount: null,
        status: "draft",
        submitted_at: null,
        approved_by: null,
        approved_at: null,
        rejected_by: null,
        rejected_at: null,
        rejection_reason: null,
        invoice_id: null,
        is_invoiced: false,
        created_by: user?.id ?? null,
      } as any);
      onOpenChange(false);
      resetForm();
    } catch (error: any) {
      const msg = error?.message || error?.error?.message || "Failed to create time entry";
      console.error("Error creating timesheet:", error);
      toast.error(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const banner =
    !empLoading && !currentEmployee ? (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Your account isn't linked to an HR record. Please contact your HR administrator.
        </AlertDescription>
      </Alert>
    ) : timeOffOverlap ? (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          You have approved time off on this date. Entry is blocked by org settings.
        </AlertDescription>
      </Alert>
    ) : null;

  const footer = (
    <>
      <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
        Cancel
      </Button>
      <Button
        type="submit"
        form="timesheet-entry-form"
        disabled={isSubmitting || !date || !hours || !currentEmployee || timeOffOverlap}
      >
        {isSubmitting ? "Saving..." : "Save Entry"}
      </Button>
    </>
  );

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title="Add Time Entry"
      description="Log working hours for a specific date."
      banner={banner}
      footer={footer}
    >
      <form id="timesheet-entry-form" onSubmit={handleSubmit} className="space-y-4">
        {recentPicks.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <span className="text-xs text-muted-foreground self-center mr-1">Recent:</span>
            {recentPicks.map((p, i) => (
              <Button
                key={i}
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => applyPick(p)}
              >
                {(p.project_name || "No project")}{p.task_name ? ` · ${p.task_name}` : ""}
              </Button>
            ))}
          </div>
        )}

        <WorkflowSheetGrid>
          <WorkflowSheetSection number={1} title="When & where" subtitle="Date and project context for this entry.">
            <WorkflowField label="Date" required>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn("w-full justify-start text-left font-normal", !date && "text-muted-foreground")}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {date ? format(date, "PPP") : "Pick a date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={date} onSelect={setDate} initialFocus />
                </PopoverContent>
              </Popover>
            </WorkflowField>

            <WorkflowField label="Project" required={!!settings?.require_project}>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger><SelectValue placeholder="Select project" /></SelectTrigger>
                <SelectContent>
                  {!settings?.require_project && <SelectItem value={NONE}>No project</SelectItem>}
                  {eligibleProjects.map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}{p.is_billable ? " · billable" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </WorkflowField>

            <WorkflowField label="Task" required={!!settings?.require_task}>
              <Select value={taskId} onValueChange={setTaskId} disabled={projectId === NONE || tasks.length === 0}>
                <SelectTrigger>
                  <SelectValue placeholder={projectId === NONE ? "Pick a project first" : "Optional"} />
                </SelectTrigger>
                <SelectContent>
                  {!settings?.require_task && <SelectItem value={NONE}>No task</SelectItem>}
                  {tasks.map((t: any) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </WorkflowField>
          </WorkflowSheetSection>

          <WorkflowSheetSection number={2} title="Hours & billing" subtitle="How long you worked and how it should bill.">
            <WorkflowField
              label="Hours"
              htmlFor="hours"
              required
              hint={
                settings?.minimum_hours_per_day || settings?.maximum_hours_per_day
                  ? `Already logged on this day: ${sameDayHours}h${settings?.maximum_hours_per_day ? ` / ${settings.maximum_hours_per_day}h max` : ""}.`
                  : undefined
              }
            >
              <Input
                id="hours"
                type="number"
                step="0.25"
                min="0.25"
                max={settings?.maximum_hours_per_day ?? 24}
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                placeholder="e.g., 8"
              />
            </WorkflowField>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5 pr-3 min-w-0">
                <div className="text-sm font-medium">Billable</div>
                <p className="text-xs text-muted-foreground">
                  {billableDisabledReason
                    ? billableDisabledReason
                    : rateLoading
                      ? "Checking the rate that applies to you\u2026"
                      : `Will bill at ${formatCurrency(resolvedRate ?? 0, selectedProject?.currency ?? null)}/hr on this project.`}
                </p>
              </div>
              <Switch
                checked={isBillable}
                disabled={!!billableDisabledReason}
                onCheckedChange={setIsBillable}
              />
            </div>
          </WorkflowSheetSection>
        </WorkflowSheetGrid>

        <WorkflowSheetSection number={3} title="Description" subtitle="Help reviewers understand the work." fullWidth>
          <WorkflowField label="Description" htmlFor="description">
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What did you work on?"
              rows={3}
            />
          </WorkflowField>
        </WorkflowSheetSection>
      </form>
    </WorkflowSheet>
  );
}
