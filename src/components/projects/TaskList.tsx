import { ProjectTask } from "@/hooks/projects/useProjectTasks";
import { ProjectStage } from "@/hooks/projects/useProjects";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckCircle2, Clock, MoreHorizontal, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { format } from "date-fns";
import { TaskBlockerChip } from "./TaskBlockerChip";
import { TooltipProvider } from "@/components/ui/tooltip";

interface TaskListProps {
  tasks: ProjectTask[];
  stages: ProjectStage[];
  onCompleteTask: (taskId: string) => Promise<void>;
  onDeleteTask: (taskId: string) => Promise<void>;
  onTaskClick?: (task: ProjectTask) => void;
  isLoading: boolean;
}

const priorityLabels: Record<number, { label: string; className: string }> = {
  0: { label: "Normal", className: "text-muted-foreground" },
  1: { label: "Low", className: "text-blue-500" },
  2: { label: "Medium", className: "text-yellow-500" },
  3: { label: "High", className: "text-orange-500" },
  4: { label: "Urgent", className: "text-destructive" },
};

export function TaskList({ tasks, stages, onCompleteTask, onDeleteTask, onTaskClick, isLoading }: TaskListProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <p className="text-muted-foreground">No tasks yet. Create your first task to get started.</p>
        </CardContent>
      </Card>
    );
  }

  const stageMap = new Map(stages.map(s => [s.id, s]));
  const taskById = new Map(tasks.map((t) => [t.id, t] as const));
  const predsFor = (t: ProjectTask) =>
    (t.depends_on ?? [])
      .map((id) => taskById.get(id))
      .filter((p): p is ProjectTask => !!p)
      .map((p) => ({ id: p.id, name: p.name, is_done: p.is_done }));

  return (
    <TooltipProvider>
    <Card>
      <CardContent className="p-0">
        <div className="divide-y">
          {tasks.map(task => {
            const stage = task.stage_id ? stageMap.get(task.stage_id) : null;
            return (
              <div
                key={task.id}
                className="flex items-center gap-3 p-3 hover:bg-muted/50 group cursor-pointer"
                onClick={() => onTaskClick?.(task)}
              >
                <Checkbox
                  checked={task.is_done}
                  onCheckedChange={(e) => {
                    onCompleteTask(task.id);
                  }}
                  onClick={e => e.stopPropagation()}
                  className="shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${task.is_done ? "line-through text-muted-foreground" : ""}`}>
                      {task.name}
                    </span>
                    <span className="text-xs text-muted-foreground">{task.task_number}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <TaskBlockerChip predecessors={predsFor(task)} size="xs" />
                  {task.priority > 0 && (
                    <span className={`text-xs font-medium ${priorityLabels[task.priority]?.className}`}>
                      {priorityLabels[task.priority]?.label}
                    </span>
                  )}
                  {stage && (
                    <Badge variant="outline" className="text-xs h-5">
                      {stage.name}
                    </Badge>
                  )}
                  {task.deadline && (
                    <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                      <Clock className="h-3 w-3" />
                      {format(new Date(task.deadline), "MMM d")}
                    </span>
                  )}

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={e => e.stopPropagation()}
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onCompleteTask(task.id); }}>
                        <CheckCircle2 className="h-3.5 w-3.5 mr-2" />
                        {task.is_done ? "Reopen" : "Complete"}
                      </DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive" onClick={(e) => { e.stopPropagation(); onDeleteTask(task.id); }}>
                        <Trash2 className="h-3.5 w-3.5 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
    </TooltipProvider>
  );
}
