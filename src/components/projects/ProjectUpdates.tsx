/**
 * ProjectUpdates — log of project status updates with composer.
 */
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, MessageSquare, Activity, CheckCircle2, UserPlus, GitBranch, Flag, Lock, FileText } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { useProjectUpdates, ProjectUpdate, useProjectActivity, ProjectActivityEvent } from "@/hooks/projects";
import { ProjectUpdateForm } from "./ProjectUpdateForm";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

interface ProjectUpdatesProps {
  projectId: string;
}

const STATUS_META: Record<ProjectUpdate["status"], { label: string; cls: string }> = {
  on_track: { label: "On track", cls: "bg-green-500/10 text-green-600 border-green-500/20" },
  at_risk: { label: "At risk", cls: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20" },
  off_track: { label: "Off track", cls: "bg-red-500/10 text-red-600 border-red-500/20" },
};

const EVENT_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  task_created: FileText,
  task_completed: CheckCircle2,
  task_assignee_changed: UserPlus,
  task_stage_changed: GitBranch,
  task_blocked: Lock,
  task_comment: MessageSquare,
  milestone_created: Flag,
  milestone_reached: Flag,
  project_update: MessageSquare,
};

export function ProjectUpdates({ projectId }: ProjectUpdatesProps) {
  const { updates, isLoading } = useProjectUpdates(projectId);
  const { events, isLoading: loadingEvents } = useProjectActivity(projectId, { limit: 100 });
  const [openForm, setOpenForm] = useState(false);

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Updates &amp; Activity
          </CardTitle>
          <Button size="sm" onClick={() => setOpenForm(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Post update
          </Button>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="updates" className="w-full">
            <TabsList className="mb-4">
              <TabsTrigger value="updates">Status updates</TabsTrigger>
              <TabsTrigger value="activity">Activity feed</TabsTrigger>
            </TabsList>
            <TabsContent value="updates">
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
          ) : updates.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No updates yet. Post the first one to set the project status.
            </p>
          ) : (
            <div className="space-y-4">
              {updates.map((u) => {
                const meta = STATUS_META[u.status];
                return (
                  <div key={u.id} className="border-l-2 pl-4 py-1" style={{
                    borderColor:
                      u.status === "on_track" ? "rgb(34 197 94)" :
                      u.status === "at_risk"  ? "rgb(234 179 8)" :
                                                "rgb(239 68 68)",
                  }}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className={meta.cls}>{meta.label}</Badge>
                      {u.progress_pct != null && (
                        <span className="text-xs text-muted-foreground">
                          {u.progress_pct}% complete
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground ml-auto">
                        {format(new Date(u.created_at), "MMM d, yyyy · HH:mm")}
                      </span>
                    </div>
                    <p className="text-sm mt-2 whitespace-pre-wrap">
                      {u.summary}
                    </p>
                    {(u.period_start || u.period_end) && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Period:{" "}
                        {u.period_start ? format(new Date(u.period_start), "MMM d") : "?"}
                        {" – "}
                        {u.period_end ? format(new Date(u.period_end), "MMM d, yyyy") : "?"}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
            </TabsContent>
            <TabsContent value="activity">
              {loadingEvents ? (
                <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
              ) : events.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No activity yet. Events appear automatically as work progresses.
                </p>
              ) : (
                <ol className="relative border-l border-border ml-3 space-y-4">
                  {events.map((e: ProjectActivityEvent) => {
                    const Icon = EVENT_ICON[e.event_type] ?? Activity;
                    return (
                      <li key={e.id} className="ml-6">
                        <span className="absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full bg-background ring-4 ring-background border">
                          <Icon className="h-3 w-3 text-muted-foreground" />
                        </span>
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="text-sm font-medium">{e.summary}</p>
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {formatDistanceToNow(new Date(e.created_at), { addSuffix: true })}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground capitalize">
                          {e.event_type.replace(/_/g, " ")}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      <ProjectUpdateForm
        open={openForm}
        onOpenChange={setOpenForm}
        projectId={projectId}
      />
    </>
  );
}
