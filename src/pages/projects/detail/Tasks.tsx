import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CalendarDays, GanttChart } from "lucide-react";
import { TaskKanban } from "@/components/projects/TaskKanban";
import { TaskList } from "@/components/projects/TaskList";
import { TaskCalendar } from "@/components/projects/TaskCalendar";
import { TaskGantt } from "@/components/projects/TaskGantt";
import { useProjectWorkspace } from "./ProjectDetailLayout";

type View = "kanban" | "list" | "calendar" | "gantt";

export default function TasksTab() {
  const { tasks, stages, tasksLoading, moveTask, completeTask, deleteTask, openTaskDetail } = useProjectWorkspace();
  const [view, setView] = useState<View>("kanban");
  const rootTasks = tasks.filter((t) => !t.parent_task_id);

  return (
    <div className="space-y-3">
      <div className="flex items-center border rounded-md w-fit">
        <Button variant={view === "kanban" ? "secondary" : "ghost"} size="sm" className="rounded-r-none h-8 text-xs" onClick={() => setView("kanban")}>Kanban</Button>
        <Button variant={view === "list" ? "secondary" : "ghost"} size="sm" className="rounded-none h-8 text-xs" onClick={() => setView("list")}>List</Button>
        <Button variant={view === "calendar" ? "secondary" : "ghost"} size="sm" className="rounded-none h-8 text-xs gap-1" onClick={() => setView("calendar")}>
          <CalendarDays className="h-3 w-3" /> Calendar
        </Button>
        <Button variant={view === "gantt" ? "secondary" : "ghost"} size="sm" className="rounded-l-none h-8 text-xs gap-1" onClick={() => setView("gantt")}>
          <GanttChart className="h-3 w-3" /> Gantt
        </Button>
      </div>
      {view === "kanban" ? (
        <TaskKanban tasks={rootTasks} stages={stages} onMoveTask={moveTask} onCompleteTask={completeTask} onDeleteTask={deleteTask} onTaskClick={openTaskDetail} isLoading={tasksLoading} />
      ) : view === "list" ? (
        <TaskList tasks={rootTasks} stages={stages} onCompleteTask={completeTask} onDeleteTask={deleteTask} onTaskClick={openTaskDetail} isLoading={tasksLoading} />
      ) : view === "calendar" ? (
        <TaskCalendar tasks={rootTasks} onTaskClick={openTaskDetail} />
      ) : (
        <TaskGantt tasks={rootTasks} onTaskClick={openTaskDetail} />
      )}
    </div>
  );
}
