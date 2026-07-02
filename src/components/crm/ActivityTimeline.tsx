import { useState } from "react";
import { format, isPast, isToday, isTomorrow, parseISO } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import {
  Phone,
  Mail,
  Users,
  Monitor,
  Calendar,
  CheckSquare,
  Clock,
  MoreHorizontal,
  Trash2,
  Edit,
  Plus,
  AlertCircle,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { CRMActivity } from "@/hooks/crm/useCRMActivities";

interface ActivityTimelineProps {
  activities: CRMActivity[];
  onMarkDone: (id: string, outcome?: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onEdit: (activity: CRMActivity) => void;
  onScheduleNew: () => void;
  isLoading?: boolean;
}

const ICON_MAP: Record<string, React.ReactNode> = {
  Call: <Phone className="h-4 w-4" />,
  Email: <Mail className="h-4 w-4" />,
  Meeting: <Users className="h-4 w-4" />,
  Demo: <Monitor className="h-4 w-4" />,
  "Follow-up": <Calendar className="h-4 w-4" />,
  Task: <CheckSquare className="h-4 w-4" />,
};

function getActivityStatus(activity: CRMActivity) {
  if (activity.is_done) return "completed";
  if (!activity.due_date) return "scheduled";
  
  const dueDate = parseISO(activity.due_date);
  if (isPast(dueDate) && !isToday(dueDate)) return "overdue";
  if (isToday(dueDate)) return "today";
  if (isTomorrow(dueDate)) return "tomorrow";
  return "scheduled";
}

function formatDueDate(activity: CRMActivity) {
  if (!activity.due_date) return "No date";
  const date = parseISO(activity.due_date);
  const status = getActivityStatus(activity);
  
  if (status === "today") return `Today${activity.due_time ? ` at ${activity.due_time}` : ""}`;
  if (status === "tomorrow") return `Tomorrow${activity.due_time ? ` at ${activity.due_time}` : ""}`;
  return format(date, "MMM d, yyyy") + (activity.due_time ? ` at ${activity.due_time}` : "");
}

export function ActivityTimeline({
  activities,
  onMarkDone,
  onDelete,
  onEdit,
  onScheduleNew,
  isLoading,
}: ActivityTimelineProps) {
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());

  const handleMarkDone = async (activity: CRMActivity) => {
    setProcessingIds((prev) => new Set([...prev, activity.id]));
    try {
      await onMarkDone(activity.id);
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(activity.id);
        return next;
      });
    }
  };

  const handleDelete = async (id: string) => {
    setProcessingIds((prev) => new Set([...prev, id]));
    try {
      await onDelete(id);
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const pendingActivities = activities.filter((a) => !a.is_done);
  const completedActivities = activities.filter((a) => a.is_done);

  if (activities.length === 0 && !isLoading) {
    return (
      <div className="text-center py-8">
        <Calendar className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
        <p className="text-muted-foreground mb-4">No activities scheduled</p>
        <Button onClick={onScheduleNew} size="sm">
          <Plus className="h-4 w-4 mr-2" />
          Schedule First Activity
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">Activities</h4>
        <Button onClick={onScheduleNew} size="sm" variant="outline">
          <Plus className="h-4 w-4 mr-2" />
          Schedule
        </Button>
      </div>

      {/* Pending Activities */}
      {pendingActivities.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">
            Upcoming ({pendingActivities.length})
          </p>
          {pendingActivities.map((activity) => {
            const status = getActivityStatus(activity);
            const isProcessing = processingIds.has(activity.id);

            return (
              <Card
                key={activity.id}
                className={cn(
                  "transition-all",
                  status === "overdue" && "border-destructive/50 bg-destructive/5",
                  status === "today" && "border-primary/50 bg-primary/5"
                )}
              >
                <CardContent className="p-3">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={false}
                      onCheckedChange={() => handleMarkDone(activity)}
                      disabled={isProcessing}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {activity.activity_type && (
                          <span className="text-muted-foreground">
                            {ICON_MAP[activity.activity_type] || <Calendar className="h-4 w-4" />}
                          </span>
                        )}
                        <span className="font-medium text-sm truncate">
                          {activity.summary}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        <span className={cn(
                          status === "overdue" && "text-destructive font-medium",
                          status === "today" && "text-primary font-medium"
                        )}>
                          {formatDueDate(activity)}
                        </span>
                        {status === "overdue" && (
                          <Badge variant="destructive" className="text-xs h-5">
                            <AlertCircle className="h-3 w-3 mr-1" />
                            Overdue
                          </Badge>
                        )}
                        {activity.duration && (
                          <span className="text-muted-foreground">
                            ({activity.duration} min)
                          </span>
                        )}
                      </div>
                      {activity.description && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                          {activity.description}
                        </p>
                      )}
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => onEdit(activity)}>
                          <Edit className="h-4 w-4 mr-2" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleDelete(activity.id)}
                          className="text-destructive"
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Completed Activities */}
      {completedActivities.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">
            Completed ({completedActivities.length})
          </p>
          {completedActivities.slice(0, 5).map((activity) => (
            <Card key={activity.id} className="opacity-60">
              <CardContent className="p-3">
                <div className="flex items-start gap-3">
                  <Checkbox checked disabled className="mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm line-through truncate">
                        {activity.summary}
                      </span>
                    </div>
                    {activity.completed_at && (
                      <p className="text-xs text-muted-foreground">
                        Completed {format(parseISO(activity.completed_at), "MMM d, yyyy")}
                        {activity.outcome && ` · ${activity.outcome}`}
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          {completedActivities.length > 5 && (
            <p className="text-xs text-muted-foreground text-center">
              +{completedActivities.length - 5} more completed
            </p>
          )}
        </div>
      )}
    </div>
  );
}
