import { ProjectTask } from "@/hooks/projects/useProjectTasks";
import { ProjectStage } from "@/hooks/projects/useProjects";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Clock, MoreHorizontal, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { format } from "date-fns";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { TaskBlockerChip } from "./TaskBlockerChip";
import { TooltipProvider } from "@/components/ui/tooltip";

interface TaskKanbanProps {
  tasks: ProjectTask[];
  stages: ProjectStage[];
  onMoveTask: (taskId: string, stageId: string) => Promise<void>;
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

export function TaskKanban({ tasks, stages, onMoveTask, onCompleteTask, onDeleteTask, onTaskClick, isLoading }: TaskKanbanProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
      </div>
    );
  }

  const taskById = new Map(tasks.map((t) => [t.id, t] as const));
  const predsFor = (t: ProjectTask) =>
    (t.depends_on ?? [])
      .map((id) => taskById.get(id))
      .filter((p): p is ProjectTask => !!p)
      .map((p) => ({ id: p.id, name: p.name, is_done: p.is_done }));

  const tasksByStage: Record<string, ProjectTask[]> = {};
  stages.forEach(s => { tasksByStage[s.id] = []; });
  tasksByStage["unassigned"] = [];

  tasks.forEach(task => {
    const stageId = task.stage_id || "unassigned";
    if (!tasksByStage[stageId]) tasksByStage[stageId] = [];
    tasksByStage[stageId].push(task);
  });

  const allColumns = [
    ...stages.map(s => ({ id: s.id, name: s.name, color: s.color, is_closed: s.is_closed })),
    ...(tasksByStage["unassigned"]?.length > 0 ? [{ id: "unassigned", name: "Unassigned", color: null, is_closed: false }] : []),
  ];

  return (
    <TooltipProvider>
    <ScrollArea className="w-full">
      <div className="flex gap-4 pb-4 min-w-max">
        {allColumns.map(col => (
          <div key={col.id} className="w-72 shrink-0">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                {col.color && (
                  <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: col.color }} />
                )}
                <h3 className="text-sm font-semibold">{col.name}</h3>
                <Badge variant="secondary" className="text-xs h-5 px-1.5">
                  {tasksByStage[col.id]?.length || 0}
                </Badge>
              </div>
            </div>
            <div className="space-y-2 min-h-[100px]">
              {(tasksByStage[col.id] || []).map(task => (
                <Card
                  key={task.id}
                  className="group hover:border-primary/40 transition-colors cursor-pointer"
                  onClick={() => onTaskClick?.(task)}
                >
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-start justify-between gap-1">
                      <div className="min-w-0">
                        <p className="text-sm font-medium leading-snug">{task.name}</p>
                        <p className="text-xs text-muted-foreground">{task.task_number}</p>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                            onClick={e => e.stopPropagation()}
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {stages.filter(s => s.id !== task.stage_id).map(s => (
                            <DropdownMenuItem key={s.id} onClick={(e) => { e.stopPropagation(); onMoveTask(task.id, s.id); }}>
                              Move to {s.name}
                            </DropdownMenuItem>
                          ))}
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onCompleteTask(task.id); }}>
                            <CheckCircle2 className="h-3.5 w-3.5 mr-2" />
                            Complete
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-destructive" onClick={(e) => { e.stopPropagation(); onDeleteTask(task.id); }}>
                            <Trash2 className="h-3.5 w-3.5 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <TaskBlockerChip predecessors={predsFor(task)} size="xs" />
                      {task.priority > 0 && (
                        <span className={`text-xs font-medium ${priorityLabels[task.priority]?.className}`}>
                          {priorityLabels[task.priority]?.label}
                        </span>
                      )}
                      {task.deadline && (
                        <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                          <Clock className="h-3 w-3" />
                          {format(new Date(task.deadline), "MMM d")}
                        </span>
                      )}
                      {task.planned_hours && (
                        <span className="text-xs text-muted-foreground">
                          {task.effective_hours}/{task.planned_hours}h
                        </span>
                      )}
                    </div>

                    {task.tags && task.tags.length > 0 && (
                      <div className="flex gap-1 flex-wrap">
                        {task.tags.slice(0, 3).map(tag => (
                          <Badge key={tag} variant="outline" className="text-[10px] h-4 px-1">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
    </TooltipProvider>
  );
}
