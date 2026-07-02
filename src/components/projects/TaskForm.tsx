/**
 * TaskForm — enterprise task composer.
 *
 * Tabbed (Details · Planning · Advanced) and writes every Stage-1 column on
 * `project_tasks`: stage, milestone, parent, assignees[] + assigned_to,
 * priority, tags, kanban_state, sequence, start_date / deadline,
 * planned_hours / remaining_hours, depends_on[], recurrence_rule (JSON).
 *
 * Attachments are added from the Task Detail panel (post-create) so we
 * don't have to do a two-phase insert here.
 */
import { useEffect, useMemo, useState } from "react";
import {
  WorkflowSheet,
} from "@/components/workflow/WorkflowSheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { CalendarIcon, X } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import type { ProjectStage, ProjectMilestone } from "@/hooks/projects/useProjects";
import type { ProjectTask } from "@/hooks/projects/useProjectTasks";
import { useProjects } from "@/hooks/projects";
import { useEmployees } from "@/hooks/useEmployees";
import { supabase } from "@/integrations/supabase/client";

export interface TaskFormPayload {
  name: string;
  description: string | null;
  stage_id: string | null;
  milestone_id: string | null;
  parent_task_id: string | null;
  assigned_to: string | null;
  assignees: string[] | null;
  priority: number;
  tags: string[] | null;
  kanban_state: "normal" | "done" | "blocked";
  sequence: number | null;
  start_date: string | null;
  deadline: string | null;
  planned_hours: number | null;
  remaining_hours: number | null;
  recurrence_rule: Record<string, unknown> | null;
  is_recurring: boolean;
  recurrence_next_at?: string | null;
  depends_on: string[] | null;
  blocked_reason: string | null;
  is_portal_visible?: boolean;
}

interface TaskFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  stages: ProjectStage[];
  /** Sibling tasks in the same project (for parent + dependency pickers) */
  siblingTasks?: Pick<ProjectTask, "id" | "name" | "task_number">[];
  onSubmit: (task: TaskFormPayload) => Promise<void>;
}

const KANBAN_STATES = [
  { v: "normal", label: "Normal" },
  { v: "done", label: "Done" },
  { v: "blocked", label: "Blocked" },
] as const;

const FREQ_OPTIONS = ["DAILY", "WEEKLY", "MONTHLY"] as const;

export function TaskForm({
  open,
  onOpenChange,
  projectId,
  stages,
  siblingTasks = [],
  onSubmit,
}: TaskFormProps) {
  const { getProjectMilestones } = useProjects();
  const { employees } = useEmployees();

  // ---- form state ----
  const [activeTab, setActiveTab] = useState("details");
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [stageId, setStageId] = useState<string>("");
  const [priority, setPriority] = useState("0");
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [assignedTo, setAssignedTo] = useState<string>(""); // primary user_id
  const [assignees, setAssignees] = useState<string[]>([]); // user_id[]

  const [startDate, setStartDate] = useState<Date | undefined>();
  const [deadline, setDeadline] = useState<Date | undefined>();
  const [plannedHours, setPlannedHours] = useState("");
  const [milestoneId, setMilestoneId] = useState<string>("");
  const [kanbanState, setKanbanState] =
    useState<TaskFormPayload["kanban_state"]>("normal");

  const [parentTaskId, setParentTaskId] = useState<string>("");
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [blockedReason, setBlockedReason] = useState("");

  const [isRecurring, setIsRecurring] = useState(false);
  const [rFreq, setRFreq] = useState<(typeof FREQ_OPTIONS)[number]>("WEEKLY");
  const [rInterval, setRInterval] = useState("1");
  const [rCount, setRCount] = useState("");
  const [rUntil, setRUntil] = useState<Date | undefined>();
  const [isPortalVisible, setIsPortalVisible] = useState(false);

  // ---- lookups ----
  const [milestones, setMilestones] = useState<ProjectMilestone[]>([]);
  useEffect(() => {
    if (!open || !projectId) return;
    void getProjectMilestones(projectId).then(setMilestones);
  }, [open, projectId, getProjectMilestones]);

  // employees with a linked auth user (for assignee pickers)
  const employeeOptions = useMemo(
    () =>
      employees
        .filter((e) => e.user_id && e.is_active)
        .map((e) => ({
          user_id: e.user_id as string,
          label:
            `${e.first_name} ${e.last_name}`.trim() ||
            e.email ||
            e.employee_number,
        })),
    [employees],
  );

  const reset = () => {
    setActiveTab("details");
    setName("");
    setDescription("");
    setStageId("");
    setPriority("0");
    setTags([]);
    setTagDraft("");
    setAssignedTo("");
    setAssignees([]);
    setStartDate(undefined);
    setDeadline(undefined);
    setPlannedHours("");
    setMilestoneId("");
    setKanbanState("normal");
    setParentTaskId("");
    setDependsOn([]);
    setBlockedReason("");
    setIsRecurring(false);
    setRFreq("WEEKLY");
    setRInterval("1");
    setRCount("");
    setRUntil(undefined);
  };

  const addTag = () => {
    const t = tagDraft.trim();
    if (!t || tags.includes(t)) return;
    setTags([...tags, t]);
    setTagDraft("");
  };

  const buildRRule = (): Record<string, unknown> | null => {
    if (!isRecurring) return null;
    const rule: Record<string, unknown> = {
      freq: rFreq,
      interval: Math.max(1, parseInt(rInterval || "1", 10)),
    };
    if (rCount) rule.count = Math.max(1, parseInt(rCount, 10));
    if (rUntil) rule.until = format(rUntil, "yyyy-MM-dd");
    return rule;
  };

  // Client-side cycle pre-check: warn if a chosen dependency
  // would obviously create A→B and B→A. Server trigger is the hard guard.
  const cycleWarning = useMemo(() => {
    if (!parentTaskId) return null;
    if (dependsOn.includes(parentTaskId)) {
      return "A task cannot depend on its own parent.";
    }
    return null;
  }, [parentTaskId, dependsOn]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setActiveTab("details");
      return;
    }
    if (kanbanState === "blocked" && !blockedReason.trim()) {
      setActiveTab("advanced");
      return;
    }
    setSubmitting(true);
    try {
      const planned = plannedHours ? parseFloat(plannedHours) : null;
      const startISO = startDate ? format(startDate, "yyyy-MM-dd") : null;
      const dueISO = deadline ? format(deadline, "yyyy-MM-dd") : null;
      // For recurring templates the cron job (`generate-recurring-tasks`)
      // requires a non-null `recurrence_next_at` cursor — seed it from the
      // first scheduled date (start_date → deadline → today) so the next
      // run actually picks the template up.
      const recurrenceNextAt = isRecurring
        ? (startISO ?? dueISO ?? format(new Date(), "yyyy-MM-dd"))
        : null;
      await onSubmit({
        name: name.trim(),
        description: description.trim() || null,
        stage_id: stageId || stages[0]?.id || null,
        milestone_id: milestoneId || null,
        parent_task_id: parentTaskId || null,
        assigned_to: assignedTo || null,
        assignees: assignees.length ? assignees : null,
        priority: parseInt(priority, 10),
        tags: tags.length ? tags : null,
        kanban_state: kanbanState,
        sequence: null,
        start_date: startISO,
        deadline: dueISO,
        planned_hours: planned,
        remaining_hours: planned,
        recurrence_rule: buildRRule(),
        is_recurring: isRecurring,
        recurrence_next_at: recurrenceNextAt,
        depends_on: dependsOn.length ? dependsOn : null,
        blocked_reason: kanbanState === "blocked" ? blockedReason.trim() : null,
        is_portal_visible: isPortalVisible,
      });
      reset();
    } catch (err) {
      // hook surfaces the toast; keep the dialog open so the user can retry
      console.error("TaskForm submit failed", err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      size="xl"
      title="New task"
      description="Track work, dependencies, planning and recurrence in one place."
      onSubmit={handleSubmit}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={submitting || !name.trim() || !!cycleWarning}
          >
            {submitting ? "Creating…" : "Create task"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">

          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid grid-cols-5 w-full">
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="planning">Planning</TabsTrigger>
              <TabsTrigger value="people">People</TabsTrigger>
              <TabsTrigger value="billing">Billing</TabsTrigger>
              <TabsTrigger value="advanced">Advanced</TabsTrigger>
            </TabsList>

            {/* ---- DETAILS ---- */}
            <TabsContent value="details" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="t-name">
                  Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="t-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="What needs to be done?"
                  autoFocus
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="t-desc">Description</Label>
                <Textarea
                  id="t-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Add context, links, acceptance criteria…"
                  rows={3}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Stage</Label>
                  <Select value={stageId} onValueChange={setStageId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                    <SelectContent>
                      {stages.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Priority</Label>
                  <Select value={priority} onValueChange={setPriority}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Normal</SelectItem>
                      <SelectItem value="1">Low</SelectItem>
                      <SelectItem value="2">Medium</SelectItem>
                      <SelectItem value="3">High</SelectItem>
                      <SelectItem value="4">Urgent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Tags</Label>
                <div className="flex gap-2">
                  <Input
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTag();
                      }
                    }}
                    placeholder="Add tag and press Enter"
                  />
                  <Button type="button" variant="outline" onClick={addTag}>
                    Add
                  </Button>
                </div>
                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {tags.map((t) => (
                      <Badge key={t} variant="secondary" className="gap-1">
                        {t}
                        <button
                          type="button"
                          onClick={() => setTags(tags.filter((x) => x !== t))}
                          aria-label={`Remove tag ${t}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>

            {/* ---- PLANNING ---- */}
            <TabsContent value="planning" className="space-y-4 mt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Start date</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !startDate && "text-muted-foreground",
                        )}
                      >
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {startDate ? format(startDate, "MMM d, yyyy") : "Pick date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={startDate}
                        onSelect={setStartDate}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-2">
                  <Label>Deadline</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !deadline && "text-muted-foreground",
                        )}
                      >
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {deadline ? format(deadline, "MMM d, yyyy") : "Pick date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={deadline}
                        onSelect={setDeadline}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="t-planned">Planned hours</Label>
                  <Input
                    id="t-planned"
                    type="number"
                    step="0.25"
                    min="0"
                    value={plannedHours}
                    onChange={(e) => setPlannedHours(e.target.value)}
                    placeholder="e.g., 8"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Kanban state</Label>
                  <Select
                    value={kanbanState}
                    onValueChange={(v) =>
                      setKanbanState(v as TaskFormPayload["kanban_state"])
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {KANBAN_STATES.map((k) => (
                        <SelectItem key={k.v} value={k.v}>
                          {k.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {kanbanState === "blocked" && (
                <div className="space-y-2">
                  <Label>
                    Blocked reason <span className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    value={blockedReason}
                    onChange={(e) => setBlockedReason(e.target.value)}
                    placeholder="Why is this task blocked?"
                    rows={2}
                  />
                </div>
              )}

              <div className="space-y-2">
                <Label>Milestone</Label>
                <Select
                  value={milestoneId || "none"}
                  onValueChange={(v) => setMilestoneId(v === "none" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {milestones.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                        {m.deadline ? ` · ${m.deadline}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </TabsContent>

            {/* ---- PEOPLE ---- */}
            <TabsContent value="people" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label>Primary assignee</Label>
                <Select
                  value={assignedTo || "none"}
                  onValueChange={(v) => setAssignedTo(v === "none" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {employeeOptions.map((e) => (
                      <SelectItem key={e.user_id} value={e.user_id}>
                        {e.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Additional assignees</Label>
                <div className="border rounded-md p-2 max-h-40 overflow-y-auto space-y-1">
                  {employeeOptions.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No employees with linked user accounts.
                    </p>
                  ) : (
                    employeeOptions.map((e) => {
                      const checked = assignees.includes(e.user_id);
                      return (
                        <label
                          key={e.user_id}
                          className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(v) =>
                              setAssignees(
                                v
                                  ? [...assignees, e.user_id]
                                  : assignees.filter((x) => x !== e.user_id),
                              )
                            }
                          />
                          <span>{e.label}</span>
                        </label>
                      );
                    })
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Followers are notified on every update; the primary assignee owns the task.
                </p>
              </div>
            </TabsContent>

            {/* ---- BILLING ---- */}
            <TabsContent value="billing" className="space-y-4 mt-4">
              <div className="space-y-3 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm">Visible to portal users</Label>
                    <p className="text-xs text-muted-foreground">
                      When on, customers / portal members of this project see this task.
                    </p>
                  </div>
                  <Switch
                    checked={isPortalVisible}
                    onCheckedChange={setIsPortalVisible}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Billable rate overrides and sale-order links live on the parent
                project; this task inherits the project's billing settings.
              </p>
            </TabsContent>

            {/* ---- ADVANCED ---- */}
            <TabsContent value="advanced" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label>Parent task</Label>
                <Select
                  value={parentTaskId || "none"}
                  onValueChange={(v) =>
                    setParentTaskId(v === "none" ? "" : v)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="None (top-level)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None (top-level)</SelectItem>
                    {siblingTasks.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.task_number} · {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Depends on</Label>
                <div className="border rounded-md p-2 max-h-40 overflow-y-auto space-y-1">
                  {siblingTasks.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No other tasks in this project yet.
                    </p>
                  ) : (
                    siblingTasks
                      .filter((t) => t.id !== parentTaskId)
                      .map((t) => {
                        const checked = dependsOn.includes(t.id);
                        return (
                          <label
                            key={t.id}
                            className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5"
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(v) =>
                                setDependsOn(
                                  v
                                    ? [...dependsOn, t.id]
                                    : dependsOn.filter((x) => x !== t.id),
                                )
                              }
                            />
                            <span className="text-muted-foreground">
                              {t.task_number}
                            </span>
                            <span>{t.name}</span>
                          </label>
                        );
                      })
                  )}
                </div>
                {cycleWarning && (
                  <p className="text-xs text-destructive">{cycleWarning}</p>
                )}
              </div>

              <div className="space-y-3 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Recurring task</Label>
                  <Switch
                    checked={isRecurring}
                    onCheckedChange={setIsRecurring}
                  />
                </div>
                {isRecurring && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Frequency</Label>
                        <Select
                          value={rFreq}
                          onValueChange={(v) =>
                            setRFreq(v as (typeof FREQ_OPTIONS)[number])
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {FREQ_OPTIONS.map((f) => (
                              <SelectItem key={f} value={f}>
                                {f.toLowerCase()}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Every N</Label>
                        <Input
                          type="number"
                          min="1"
                          value={rInterval}
                          onChange={(e) => setRInterval(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">End after N runs</Label>
                        <Input
                          type="number"
                          min="1"
                          value={rCount}
                          onChange={(e) => setRCount(e.target.value)}
                          placeholder="optional"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">End by</Label>
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              type="button"
                              variant="outline"
                              className={cn(
                                "w-full justify-start text-left font-normal",
                                !rUntil && "text-muted-foreground",
                              )}
                            >
                              <CalendarIcon className="mr-2 h-4 w-4" />
                              {rUntil
                                ? format(rUntil, "MMM d, yyyy")
                                : "optional"}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent
                            className="w-auto p-0"
                            align="start"
                          >
                            <Calendar
                              mode="single"
                              selected={rUntil}
                              onSelect={setRUntil}
                              initialFocus
                            />
                          </PopoverContent>
                        </Popover>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      A recurrence rule is stored on the task; the cron job
                      generates future occurrences.
                    </p>
                    {(() => {
                      const seed = startDate ?? deadline ?? new Date();
                      const interval = Math.max(1, parseInt(rInterval || "1", 10));
                      const next = new Date(seed);
                      if (rFreq === "DAILY") next.setDate(next.getDate() + interval);
                      else if (rFreq === "WEEKLY") next.setDate(next.getDate() + 7 * interval);
                      else if (rFreq === "MONTHLY") next.setMonth(next.getMonth() + interval);
                      const ok = !rUntil || next <= rUntil;
                      return (
                        <p className="text-xs text-muted-foreground">
                          Next occurrence: {ok ? format(next, "EEE, MMM d, yyyy") : "— (past end date)"}
                        </p>
                      );
                    })()}
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>
      </div>
    </WorkflowSheet>
  );
}

// Re-export so callers can keep importing the component without a separate
// payload import path.
export type { TaskFormPayload as TaskFormSubmit };

// Suppress unused-import warning for `supabase` (kept for future inline
// dependency-cycle pre-check via RPC).
void supabase;
