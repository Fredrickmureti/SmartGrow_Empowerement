/**
 * ProjectDetailLayout — sticky header + route-aware tab strip + <Outlet />.
 *
 * Replaces the flat <Tabs> page. Each tab is a real route under
 * /projects-app/:projectId/<tab>. State (project, stages, tasks, refresh
 * handlers) flows down via Outlet context so child pages stay thin.
 */
import { useState, useEffect, useCallback, createContext, useContext } from "react";
import { useParams, useNavigate, NavLink, Outlet, useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useProjects, Project, ProjectStage } from "@/hooks/projects";
import { useProjectTasks, ProjectTask } from "@/hooks/projects";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  ArrowLeft, Calendar, Clock, Plus, Settings, ListTodo, Milestone,
  Timer, DollarSign, FileText, MessageSquare, LayoutDashboard,
  ShoppingCart, Receipt, Activity as ActivityIcon,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { TaskForm } from "@/components/projects/TaskForm";
import { TaskDetail } from "@/components/projects/TaskDetail";
import { ProjectReportsMenu } from "@/components/projects/ProjectReportsMenu";
import { cn } from "@/lib/utils";

const statusColors: Record<string, string> = {
  active: "bg-green-500/10 text-green-600 border-green-500/20",
  completed: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  on_hold: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  cancelled: "bg-red-500/10 text-red-600 border-red-500/20",
  draft: "bg-muted text-muted-foreground border-border",
};

interface ProjectCtx {
  project: Project;
  stages: ProjectStage[];
  tasks: ProjectTask[];
  tasksLoading: boolean;
  refreshProject: () => Promise<void>;
  refreshTasks: () => Promise<void>;
  refreshStages: () => Promise<void>;
  openTaskForm: () => void;
  openTaskDetail: (task: ProjectTask) => void;
  moveTask: (taskId: string, stageId: string) => Promise<void>;
  completeTask: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
}

const ProjectContext = createContext<ProjectCtx | null>(null);
export function useProjectWorkspace(): ProjectCtx {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProjectWorkspace must be used inside ProjectDetailLayout");
  return ctx;
}

const TABS: Array<{ to: string; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { to: "overview", label: "Overview", icon: LayoutDashboard },
  { to: "tasks", label: "Tasks", icon: ListTodo },
  { to: "milestones", label: "Milestones", icon: Milestone },
  { to: "timesheets", label: "Timesheets", icon: Timer },
  { to: "sales", label: "Sales", icon: ShoppingCart },
  { to: "purchases", label: "Purchases", icon: Receipt },
  { to: "financials", label: "Financials", icon: DollarSign },
  { to: "documents", label: "Documents", icon: FileText },
  { to: "updates", label: "Updates", icon: MessageSquare },
  { to: "activity", label: "Activity", icon: ActivityIcon },
  { to: "settings", label: "Settings", icon: Settings },
];

export default function ProjectDetailLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { currentOrg } = useOrganization();
  const { getProjectStages, getProjectProgress, updateProject } = useProjects();
  const {
    tasks, isLoading: tasksLoading,
    createTask, moveTask, completeTask, deleteTask, refreshTasks,
  } = useProjectTasks(projectId);

  const [project, setProject] = useState<Project | null>(null);
  const [stages, setStages] = useState<ProjectStage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [selectedTask, setSelectedTask] = useState<ProjectTask | null>(null);
  const [taskDetailOpen, setTaskDetailOpen] = useState(false);

  const fetchProject = useCallback(async () => {
    if (!projectId || !currentOrg) return;
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("projects")
        .select(`*, customer:contacts(id, name, is_company)`)
        .eq("id", projectId)
        .eq("organization_id", currentOrg.id)
        .single();

      if (error) throw error;
      const progress = await getProjectProgress(projectId);
      setProject({ ...(data as object), progress } as unknown as Project);
      const stagesData = await getProjectStages(projectId);
      setStages(stagesData);
    } catch (error) {
      console.error("Error fetching project:", error);
      toast.error("Failed to load project");
      navigate("/projects-app/list");
    } finally {
      setIsLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, currentOrg?.id]);

  useEffect(() => { fetchProject(); }, [fetchProject]);

  // Realtime: react to task/milestone changes inside this project workspace.
  // Channels are scoped per project and torn down on unmount — no leaks.
  useEffect(() => {
    if (!projectId) return;
    const channel = supabase
      .channel(`project-${projectId}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "project_tasks", filter: `project_id=eq.${projectId}` },
        () => { void refreshTasks(); })
      .on("postgres_changes",
        { event: "*", schema: "public", table: "project_milestones", filter: `project_id=eq.${projectId}` },
        () => { void fetchProject(); })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [projectId, refreshTasks, fetchProject]);

  // Redirect bare /:projectId to /:projectId/overview
  useEffect(() => {
    if (!projectId) return;
    const base = `/projects-app/${projectId}`;
    if (location.pathname === base || location.pathname === base + "/") {
      navigate(`${base}/overview`, { replace: true });
    }
  }, [projectId, location.pathname, navigate]);

  const refreshStages = useCallback(async () => {
    if (!projectId) return;
    const s = await getProjectStages(projectId);
    setStages(s);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const handleTaskDetailUpdate = async () => {
    await refreshTasks();
    await fetchProject();
  };

  if (isLoading || !project) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const completedTasks = tasks.filter((t) => t.is_done).length;
  const totalTasks = tasks.filter((t) => !t.parent_task_id).length;

  const ctx: ProjectCtx = {
    project,
    stages,
    tasks,
    tasksLoading,
    refreshProject: fetchProject,
    refreshTasks,
    refreshStages,
    openTaskForm: () => setShowTaskForm(true),
    openTaskDetail: (task) => { setSelectedTask(task); setTaskDetailOpen(true); },
    moveTask,
    completeTask,
    deleteTask,
  };

  return (
    <div className="space-y-4">
      {/* Sticky header */}
      <div className="sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 -mx-4 sm:-mx-6 px-4 sm:px-6 pt-2 pb-3 border-b">
        <div className="flex items-center gap-2 mb-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/projects-app/list")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: project.color || "#3b82f6" }} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold tracking-tight truncate">{project.name}</h1>
              <Badge variant="outline" className={statusColors[project.status || "draft"]}>{project.status}</Badge>
              <span className="text-sm text-muted-foreground">{project.project_number}</span>
              {project.customer && (
                <span className="text-sm text-muted-foreground">· {project.customer.name}</span>
              )}
            </div>
            {project.description && (
              <p className="text-sm text-muted-foreground mt-0.5 line-clamp-1">{project.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <ProjectReportsMenu projectId={project.id} projectName={project.name} />
            <Button size="sm" onClick={() => setShowTaskForm(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> New Task
            </Button>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-4 mb-3">
          <Card><CardContent className="p-2.5"><div className="flex items-center gap-2"><ListTodo className="h-4 w-4 text-muted-foreground" /><div><p className="text-xs text-muted-foreground">Tasks</p><p className="text-sm font-semibold">{completedTasks}/{totalTasks}</p></div></div></CardContent></Card>
          <Card><CardContent className="p-2.5"><div className="flex items-center gap-2"><Clock className="h-4 w-4 text-muted-foreground" /><div><p className="text-xs text-muted-foreground">Hours</p><p className="text-sm font-semibold">{project.spent_hours || 0}{project.allocated_hours ? `/${project.allocated_hours}` : ""}h</p></div></div></CardContent></Card>
          <Card><CardContent className="p-2.5"><div className="flex items-center gap-2"><Calendar className="h-4 w-4 text-muted-foreground" /><div><p className="text-xs text-muted-foreground">Deadline</p><p className="text-sm font-medium">{project.end_date ? format(new Date(project.end_date), "MMM d, yyyy") : "None"}</p></div></div></CardContent></Card>
          <Card><CardContent className="p-2.5"><div className="space-y-1"><div className="flex justify-between text-xs"><span className="text-muted-foreground">Progress</span><span className="font-medium">{project.progress ?? 0}%</span></div><Progress value={project.progress ?? 0} className="h-2" /></div></CardContent></Card>
        </div>

        {/* Tab strip */}
        <div className="flex gap-1 overflow-x-auto -mx-1 px-1">
          {TABS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md whitespace-nowrap transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </NavLink>
          ))}
        </div>
      </div>

      <ProjectContext.Provider value={ctx}>
        <div className="pt-2">
          <Outlet />
        </div>
      </ProjectContext.Provider>

      <TaskForm
        open={showTaskForm}
        onOpenChange={setShowTaskForm}
        projectId={projectId!}
        stages={stages}
        siblingTasks={tasks.map((t) => ({ id: t.id, name: t.name, task_number: t.task_number }))}
        onSubmit={async (task) => {
          await createTask({
            ...task,
            project_id: projectId!,
            effective_hours: 0,
            progress: 0,
            is_blocked: task.kanban_state === "blocked",
            is_done: task.kanban_state === "done",
            is_active: true,
            created_by: null,
            completed_at: null,
            completed_by: null,
            blocked_override_by: null,
            blocked_override_at: null,
            blocked_override_reason: null,
          });
          setShowTaskForm(false);
        }}
      />

      <TaskDetail
        task={selectedTask}
        stages={stages}
        open={taskDetailOpen}
        onOpenChange={setTaskDetailOpen}
        onUpdate={handleTaskDetailUpdate}
        projectId={projectId!}
      />
    </div>
  );
}
