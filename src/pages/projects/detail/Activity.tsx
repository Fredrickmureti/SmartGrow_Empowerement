/**
 * Activity tab — unified project activity feed.
 *
 * Reads from `project_activity_log` via `useProjectActivity` (realtime).
 * Renders chronological events: tasks, milestones, updates, comments.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDistanceToNow } from "date-fns";
import {
  Activity as ActivityIcon, ListTodo, Milestone, MessageSquare, FileEdit,
} from "lucide-react";
import { useProjectActivity } from "@/hooks/projects/useProjectActivity";
import { useProjectWorkspace } from "./ProjectDetailLayout";

const ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  task_created: ListTodo,
  task_updated: ListTodo,
  task_completed: ListTodo,
  task_deleted: ListTodo,
  milestone_created: Milestone,
  milestone_completed: Milestone,
  update_posted: FileEdit,
  comment_posted: MessageSquare,
};

const COLOR: Record<string, string> = {
  task_completed: "bg-emerald-500/10 text-emerald-600",
  milestone_completed: "bg-emerald-500/10 text-emerald-600",
  task_deleted: "bg-destructive/10 text-destructive",
};

export default function ActivityTab() {
  const { project } = useProjectWorkspace();
  const { events, isLoading } = useProjectActivity(project.id, { limit: 200 });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ActivityIcon className="h-4 w-4" /> Activity
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground py-12 text-center">
            No activity yet. Create a task or post an update to get started.
          </p>
        ) : (
          <ol className="space-y-3">
            {events.map((e) => {
              const Icon = ICON[e.event_type] ?? ActivityIcon;
              const tone = COLOR[e.event_type] ?? "bg-muted text-foreground";
              return (
                <li key={e.id} className="flex items-start gap-3">
                  <div className={`mt-0.5 rounded-full p-1.5 ${tone}`}>
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm">{e.summary}</p>
                      <Badge variant="outline" className="text-[10px] uppercase">
                        {e.event_type.replace(/_/g, " ")}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(e.created_at), { addSuffix: true })}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
