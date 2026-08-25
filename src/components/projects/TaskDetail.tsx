import { useState, useEffect } from "react";
import { ProjectTask, TaskActivity } from "@/hooks/projects/useProjectTasks";
import { ProjectStage } from "@/hooks/projects/useProjects";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, History, Play, Square, Timer, GitBranch, Lock, Plus } from "lucide-react";
import { format } from "date-fns";
import { useProjectTasks, useTaskFollowers } from "@/hooks/projects";
import { TaskComments } from "@/components/projects/TaskComments";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { insertTimesheet, resolveMyEmployeeId } from "@/lib/timesheets/timesheetWriter";


interface TaskDetailProps {
  task: ProjectTask | null;
  stages: ProjectStage[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate: () => Promise<void>;
  projectId: string;
}

export function TaskDetail({ task, stages, open, onOpenChange, onUpdate, projectId }: TaskDetailProps) {
  const { tasks: allTasks, updateTask, completeTask, reopenTask, getTaskActivities, createTask } = useProjectTasks(projectId);
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { followers, isFollowing, follow, unfollow } = useTaskFollowers(task?.id);

  const subtasks = task ? allTasks.filter(t => t.parent_task_id === task.id) : [];
  const predecessors = task?.depends_on?.length
    ? allTasks.filter(t => task.depends_on!.includes(t.id))
    : [];
  const openPredecessors = predecessors.filter(p => !p.is_done);

  const [newSubtaskName, setNewSubtaskName] = useState("");
  const [addingSubtask, setAddingSubtask] = useState(false);

  const [activities, setActivities] = useState<TaskActivity[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editStage, setEditStage] = useState("");
  const [editPriority, setEditPriority] = useState("0");

  // Time logging
  const [logHours, setLogHours] = useState("");
  const [logDescription, setLogDescription] = useState("");
  const [isLoggingTime, setIsLoggingTime] = useState(false);

  // Timer
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerStart, setTimerStart] = useState<number | null>(null);
  const [timerElapsed, setTimerElapsed] = useState(0);

  useEffect(() => {
    if (task && open) {
      setEditName(task.name);
      setEditDescription(task.description || "");
      setEditStage(task.stage_id || "");
      setEditPriority(String(task.priority));
      loadActivities();
    }
  }, [task?.id, open]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (timerRunning && timerStart) {
      interval = setInterval(() => {
        setTimerElapsed(Math.floor((Date.now() - timerStart) / 1000));
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [timerRunning, timerStart]);

  const loadActivities = async () => {
    if (!task) return;
    const data = await getTaskActivities(task.id);
    setActivities(data);
  };

  const handleSave = async () => {
    if (!task) return;
    try {
      await updateTask(task.id, {
        name: editName,
        description: editDescription || null,
        stage_id: editStage || null,
        priority: parseInt(editPriority),
      } as any);
      setIsEditing(false);
      await onUpdate();
    } catch {
      toast.error("Failed to update task");
    }
  };

  const handleLogTime = async () => {
    if (!task || !currentOrg || !user || !logHours) return;
    setIsLoggingTime(true);
    try {
      const scope = {
        organizationId: currentOrg.id,
        businessId: currentBusiness?.id ?? null,
        userId: user.id,
      };
      const employeeId = await resolveMyEmployeeId(scope);

      if (!employeeId) {
        toast.error("No employee record found for your user. Please set up your employee profile first.");
        return;
      }

      const hours = parseFloat(logHours);
      await insertTimesheet(scope, {
        employee_id: employeeId,
        project_id: projectId,
        task_id: task.id,
        date: new Date().toISOString().split("T")[0],
        hours,
        description: logDescription || `Time on ${task.name}`,
      });


      toast.success(`${hours}h logged successfully`);
      setLogHours("");
      setLogDescription("");
      await onUpdate();
    } catch (error) {
      console.error("Error logging time:", error);
      toast.error("Failed to log time");
    } finally {
      setIsLoggingTime(false);
    }
  };

  const handleTimerToggle = () => {
    if (timerRunning) {
      // Stop and populate hours field
      const hours = (timerElapsed / 3600).toFixed(2);
      setLogHours(hours);
      setTimerRunning(false);
      setTimerStart(null);
      setTimerElapsed(0);
    } else {
      setTimerRunning(true);
      setTimerStart(Date.now());
      setTimerElapsed(0);
    }
  };

  const formatTimer = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  if (!task) return null;

  const priorityLabels: Record<number, string> = { 0: "Normal", 1: "Low", 2: "Medium", 3: "High", 4: "Urgent" };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <SheetTitle className="text-left flex-1">{task.task_number}</SheetTitle>
            <Badge variant={task.is_done ? "secondary" : "outline"}>
              {task.is_done ? "Done" : "Open"}
            </Badge>
            <Button
              size="sm"
              variant={isFollowing ? "secondary" : "outline"}
              onClick={() => (isFollowing ? unfollow() : follow())}
              title={isFollowing ? "Stop receiving notifications for this task" : "Get notified about comments and changes on this task"}
            >
              {isFollowing ? "Following" : "Follow"}
              <span className="ml-1.5 text-xs text-muted-foreground">({followers.length})</span>
            </Button>
          </div>
        </SheetHeader>

        <div className="space-y-6 mt-4">
          {/* Task info / edit */}
          {isEditing ? (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input value={editName} onChange={e => setEditName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Description</Label>
                <Textarea value={editDescription} onChange={e => setEditDescription(e.target.value)} rows={3} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Stage</Label>
                  <Select value={editStage} onValueChange={setEditStage}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {stages.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Priority</Label>
                  <Select value={editPriority} onValueChange={setEditPriority}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(priorityLabels).map(([v, l]) => (
                        <SelectItem key={v} value={v}>{l}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSave}>Save</Button>
                <Button size="sm" variant="outline" onClick={() => setIsEditing(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-start justify-between">
                <h3 className="font-semibold text-lg">{task.name}</h3>
                <Button size="sm" variant="outline" onClick={() => setIsEditing(true)}>Edit</Button>
              </div>
              {task.description && <p className="text-sm text-muted-foreground">{task.description}</p>}
              <div className="flex gap-2 flex-wrap text-xs text-muted-foreground">
                {task.stage?.name && <Badge variant="outline">{task.stage.name}</Badge>}
                <span>Priority: {priorityLabels[task.priority]}</span>
                {task.deadline && <span>Due: {format(new Date(task.deadline), "MMM d, yyyy")}</span>}
                {task.planned_hours && <span>Planned: {task.planned_hours}h</span>}
                <span>Logged: {task.effective_hours}h</span>
              </div>
              <div className="flex gap-2 pt-1">
                {task.is_done ? (
                  <Button size="sm" variant="outline" onClick={async () => { await reopenTask(task.id); await onUpdate(); }}>
                    Reopen
                  </Button>
                ) : (
                  <Button size="sm" onClick={async () => {
                    if (openPredecessors.length > 0) {
                      const reason = window.prompt(
                        `This task is blocked by ${openPredecessors.length} unfinished predecessor(s):\n\n${openPredecessors.map(p => `• ${p.task_number} ${p.name}`).join("\n")}\n\nEnter a reason to override and complete (manager action). Cancel to abort.`,
                        ""
                      );
                      if (reason === null) return;
                      await updateTask(task.id, {
                        blocked_override_reason: reason || "Override (no reason provided)",
                      });
                    }
                    await completeTask(task.id);
                    await onUpdate();
                  }}>
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                    Complete
                  </Button>
                )}
              </div>

              {predecessors.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Lock className="h-3 w-3" />
                    Blocked by:
                  </span>
                  {predecessors.map(p => (
                    <Badge
                      key={p.id}
                      variant={p.is_done ? "secondary" : "destructive"}
                      className="text-[10px]"
                    >
                      {p.task_number} {p.is_done ? "✓" : ""}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}

          <Separator />

          {/* Subtasks */}
          <div className="space-y-2">
            <h4 className="text-sm font-semibold flex items-center gap-1.5">
              <GitBranch className="h-4 w-4" />
              Subtasks ({subtasks.length})
            </h4>
            {subtasks.length > 0 && (
              <div className="space-y-1">
                {subtasks.map(st => (
                  <div key={st.id} className="flex items-center gap-2 text-sm border rounded p-1.5">
                    <CheckCircle2
                      className={`h-3.5 w-3.5 shrink-0 ${st.is_done ? "text-success" : "text-muted-foreground"}`}
                    />
                    <span className={`flex-1 truncate ${st.is_done ? "line-through text-muted-foreground" : ""}`}>
                      {st.task_number} · {st.name}
                    </span>
                    {st.assignee?.email && (
                      <span className="text-[10px] text-muted-foreground">{st.assignee.email}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Input
                placeholder="Add subtask..."
                value={newSubtaskName}
                onChange={e => setNewSubtaskName(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Enter" && newSubtaskName.trim() && !addingSubtask) {
                    setAddingSubtask(true);
                    try {
                      await createTask({
                        project_id: projectId,
                        stage_id: task.stage_id,
                        parent_task_id: task.id,
                        milestone_id: task.milestone_id,
                        name: newSubtaskName.trim(),
                        description: null,
                        assigned_to: null,
                        assignees: null,
                        priority: 0,
                        tags: null,
                        start_date: null,
                        deadline: null,
                        planned_hours: null,
                        effective_hours: 0,
                        remaining_hours: null,
                        progress: 0,
                        is_recurring: false,
                        recurrence_rule: null,
                        depends_on: null,
                        is_blocked: false,
                        blocked_reason: null,
                        is_done: false,
                        completed_at: null,
                        completed_by: null,
                        is_active: true,
                        created_by: null,
                      } as any);
                      setNewSubtaskName("");
                      await onUpdate();
                    } finally {
                      setAddingSubtask(false);
                    }
                  }
                }}
                className="flex-1 h-8 text-sm"
              />
              <Button size="sm" variant="outline" disabled={!newSubtaskName.trim() || addingSubtask}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <Separator />

          {/* Time Logging */}
          <div className="space-y-3">
            <h4 className="text-sm font-semibold flex items-center gap-1.5">
              <Timer className="h-4 w-4" />
              Log Time
            </h4>

            {/* Timer */}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={timerRunning ? "destructive" : "outline"}
                onClick={handleTimerToggle}
                className="gap-1"
              >
                {timerRunning ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                {timerRunning ? formatTimer(timerElapsed) : "Start Timer"}
              </Button>
            </div>

            <div className="flex gap-2">
              <Input
                type="number"
                placeholder="Hours"
                value={logHours}
                onChange={e => setLogHours(e.target.value)}
                className="w-24"
                step="0.25"
              />
              <Input
                placeholder="Description (optional)"
                value={logDescription}
                onChange={e => setLogDescription(e.target.value)}
                className="flex-1"
              />
              <Button size="sm" onClick={handleLogTime} disabled={!logHours || isLoggingTime}>
                Log
              </Button>
            </div>
          </div>

          <Separator />

          {/* Chatter — new task_comments thread */}
          <TaskComments taskId={task.id} />

          {activities.length > 0 && (
            <>
              <Separator />
              <div className="space-y-2">
                <h4 className="text-sm font-semibold flex items-center gap-1.5">
                  <History className="h-4 w-4" />
                  Activity log
                </h4>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {activities.map((a) => (
                    <Card key={a.id}>
                      <CardContent className="p-2.5">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm">{a.content}</p>
                          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                            {format(new Date(a.created_at), "MMM d, HH:mm")}
                          </span>
                        </div>
                        <Badge variant="outline" className="text-[10px] h-4 mt-1">
                          {a.activity_type}
                        </Badge>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
