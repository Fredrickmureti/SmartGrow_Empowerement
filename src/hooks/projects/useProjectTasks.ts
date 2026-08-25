import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

export interface ProjectTask {
  id: string;
  organization_id: string;
  project_id: string;
  stage_id: string | null;
  parent_task_id: string | null;
  milestone_id: string | null;
  task_number: string;
  name: string;
  description: string | null;
  assigned_to: string | null;
  assignees: string[] | null;
  priority: number;
  tags: string[] | null;
  start_date: string | null;
  deadline: string | null;
  planned_hours: number | null;
  effective_hours: number;
  remaining_hours: number | null;
  progress: number;
  is_recurring: boolean;
  recurrence_rule: Record<string, unknown> | null;
  depends_on: string[] | null;
  is_blocked: boolean;
  blocked_reason: string | null;
  blocked_override_by: string | null;
  blocked_override_at: string | null;
  blocked_override_reason: string | null;
  is_done: boolean;
  completed_at: string | null;
  completed_by: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Joined data
  stage?: {
    id: string;
    name: string;
    color: string | null;
    is_closed: boolean;
  };
  project?: {
    id: string;
    name: string;
    project_number: string;
  };
  assignee?: {
    id: string;
    email: string;
  };
  subtasks?: ProjectTask[];
}

export interface TaskActivity {
  id: string;
  task_id: string;
  activity_type: "comment" | "status_change" | "assignment" | "attachment" | "time_logged";
  content: string | null;
  metadata: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  // Joined
  user?: {
    id: string;
    email: string;
  };
}

export function useProjectTasks(projectId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchTasks = useCallback(async () => {
    if (!currentOrg || !currentBusiness) return;
    setIsLoading(true);

    try {
      let query = supabase
        .from("project_tasks")
        .select(`
          *,
          stage:project_stages(id, name, color, is_closed),
          project:projects(id, name, project_number)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true)
        .order("created_at", { ascending: false });

      if (projectId) {
        query = query.eq("project_id", projectId);
      }

      const { data, error } = await query;

      if (error) throw error;
      setTasks((data || []) as unknown as ProjectTask[]);
    } catch (error) {
      console.error("Error fetching tasks:", error);
      toast.error("Failed to fetch tasks");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, projectId]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const getNextTaskNumber = async (projectId: string): Promise<string> => {
    const { data, error } = await supabase.rpc("get_next_task_number", {
      p_project_id: projectId,
    });

    if (error) {
      console.error("Error getting task number:", error);
      return `TSK-${Date.now()}`;
    }

    return data || "TSK-0001";
  };

  const createTask = async (
    task: Omit<ProjectTask, "id" | "organization_id" | "task_number" | "created_at" | "updated_at" | "stage" | "project" | "assignee" | "subtasks">
  ) => {
    if (!currentOrg || !user) throw new Error("No organization selected");

    const taskNumber = await getNextTaskNumber(task.project_id);

    const { data, error } = await supabase
      .from("project_tasks")
      .insert({
        project_id: task.project_id,
        stage_id: task.stage_id,
        parent_task_id: task.parent_task_id,
        milestone_id: task.milestone_id,
        name: task.name,
        description: task.description,
        assigned_to: task.assigned_to,
        assignees: task.assignees,
        priority: task.priority,
        tags: task.tags,
        start_date: task.start_date,
        deadline: task.deadline,
        planned_hours: task.planned_hours,
        effective_hours: task.effective_hours,
        remaining_hours: task.remaining_hours,
        progress: task.progress,
        is_recurring: task.is_recurring,
        depends_on: task.depends_on,
        is_blocked: task.is_blocked,
        blocked_reason: task.blocked_reason,
        is_done: task.is_done,
        is_active: task.is_active,
        is_portal_visible: (task as any).is_portal_visible ?? false,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        task_number: taskNumber,
        created_by: user.id,
      } as any)
      .select()
      .single();

    if (error) throw error;

    // Log activity
    await logActivity(data.id, "status_change", `Task created`);

    toast.success(`Task ${taskNumber} created successfully`);
    await fetchTasks();
    return data;
  };

  const updateTask = async (id: string, updates: Partial<ProjectTask>) => {
    // Lifecycle fields are governed by the server commands below; strip them
    // from generic field edits so an ad-hoc form cannot bypass the guards.
    const { is_done, completed_at, completed_by, stage_id, assigned_to, ...fields } =
      updates as Record<string, unknown> & Partial<ProjectTask>;

    if (Object.keys(fields).length > 0) {
      const { error } = await supabase
        .from("project_tasks")
        .update(fields as any)
        .eq("id", id);
      if (error) throw error;
    }

    if (stage_id !== undefined && stage_id !== null) await moveTask(id, stage_id);
    if (assigned_to !== undefined) await assignTask(id, assigned_to ?? null);
    if (is_done !== undefined) {
      if (is_done) await completeTask(id);
      else await reopenTask(id);
    }

    toast.success("Task updated successfully");
    await fetchTasks();
  };


  /**
   * Wave 2 — task lifecycle is server-owned. `project_task_*` RPCs enforce
   * project-write access, project-closed guards, dependency ordering and
   * write the non-forgeable entry in `project_activity_log`. The browser
   * must never flip `is_done` / `stage_id` / `assigned_to` directly.
   */
  const callTaskRpc = async (fn: string, args: Record<string, unknown>) => {
    const { error } = await (supabase.rpc as unknown as (
      f: string,
      a: Record<string, unknown>,
    ) => Promise<{ error: { message: string } | null }>)(fn, args);
    if (error) throw new Error(error.message);
    await fetchTasks();
  };

  const moveTask = async (taskId: string, newStageId: string) => {
    await callTaskRpc("project_task_move_stage", { _task_id: taskId, _stage_id: newStageId });
  };

  const completeTask = async (id: string) => {
    await callTaskRpc("project_task_complete", { _task_id: id });
    toast.success("Task completed!");
  };

  const reopenTask = async (id: string) => {
    await callTaskRpc("project_task_reopen", { _task_id: id });
    toast.success("Task reopened");
  };

  const deleteTask = async (id: string) => {
    const { error } = await supabase
      .from("project_tasks")
      .update({ is_active: false })
      .eq("id", id);

    if (error) throw error;

    toast.success("Task deleted successfully");
    await fetchTasks();
  };

  const assignTask = async (taskId: string, userId: string | null) => {
    await callTaskRpc("project_task_assign", { _task_id: taskId, _user_id: userId });
  };


  // Activity logging
  const logActivity = async (
    taskId: string,
    activityType: TaskActivity["activity_type"],
    content: string,
    metadata?: Record<string, unknown>
  ) => {
    if (!user) return;

    await supabase.from("project_task_activities").insert({
      task_id: taskId,
      activity_type: activityType,
      content,
      metadata: metadata || null,
      created_by: user.id,
    } as any);
  };

  const addComment = async (taskId: string, content: string) => {
    await logActivity(taskId, "comment", content);
    toast.success("Comment added");
  };

  const getTaskActivities = async (taskId: string): Promise<TaskActivity[]> => {
    const { data, error } = await supabase
      .from("project_task_activities")
      .select("*")
      .eq("task_id", taskId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching task activities:", error);
      return [];
    }

    return (data || []) as TaskActivity[];
  };

  // Get tasks by stage for Kanban view
  const getTasksByStage = () => {
    const tasksByStage: Record<string, ProjectTask[]> = {};
    
    tasks.forEach((task) => {
      const stageId = task.stage_id || "unassigned";
      if (!tasksByStage[stageId]) {
        tasksByStage[stageId] = [];
      }
      if (!task.parent_task_id) {
        // Only top-level tasks
        tasksByStage[stageId].push(task);
      }
    });

    return tasksByStage;
  };

  // Get my tasks (assigned to current user)
  const getMyTasks = () => {
    if (!user) return [];
    return tasks.filter((t) => t.assigned_to === user.id || t.assignees?.includes(user.id));
  };

  return {
    tasks,
    myTasks: getMyTasks(),
    isLoading,
    getNextTaskNumber,
    createTask,
    updateTask,
    moveTask,
    completeTask,
    reopenTask,
    deleteTask,
    assignTask,
    addComment,
    getTaskActivities,
    getTasksByStage,
    refreshTasks: fetchTasks,
  };
}
