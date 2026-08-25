import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Calendar,
  Clock,
  Phone,
  Mail,
  Users,
  Monitor,
  CheckSquare,
  AlertCircle,
  CheckCircle2,
  ArrowRight,
  Loader2,
} from "lucide-react";
import { format, isPast, isToday, isTomorrow, parseISO, startOfDay, addDays } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router-dom";

interface ActivityWithLead {
  id: string;
  lead_id: string;
  activity_type: string | null;
  summary: string;
  description: string | null;
  due_date: string | null;
  due_time: string | null;
  duration: number | null;
  is_done: boolean;
  completed_at: string | null;
  outcome: string | null;
  lead: {
    id: string;
    name: string;
    company_contact: { name: string } | null;
  };
}

const ICON_MAP: Record<string, React.ReactNode> = {
  Call: <Phone className="h-4 w-4" />,
  Email: <Mail className="h-4 w-4" />,
  Meeting: <Users className="h-4 w-4" />,
  Demo: <Monitor className="h-4 w-4" />,
  "Follow-up": <Calendar className="h-4 w-4" />,
  Task: <CheckSquare className="h-4 w-4" />,
};

export default function CRMActivities() {
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const [activities, setActivities] = useState<ActivityWithLead[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());

  const fetchActivities = useCallback(async () => {
    // Activities are a CRM-scoped operational record — they live on a
    // specific Company's books. Refuse to query without a business_id to
    // prevent cross-Company contamination in multi-company workspaces.
    if (!currentOrg || !currentBusiness?.id) {
      setActivities([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("crm_activities")
        .select(`
          id,
          lead_id,
          activity_type,
          summary,
          description,
          due_date,
          due_time,
          duration,
          is_done,
          completed_at,
          outcome,
          lead:crm_leads(id, name, company_contact:contacts!crm_leads_business_company_contact_fkey(name))
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("due_date", { ascending: true, nullsFirst: false });

      if (error) throw error;
      setActivities((data || []) as unknown as ActivityWithLead[]);
    } catch (error) {
      console.error("Error fetching activities:", error);
      toast.error("Failed to fetch activities");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);

  const markAsDone = async (activityId: string) => {
    if (!user) return;
    setProcessingIds((prev) => new Set([...prev, activityId]));

    try {
      const { error } = await supabase
        .from("crm_activities")
        .update({
          is_done: true,
          completed_at: new Date().toISOString(),
          completed_by: user.id,
        })
        .eq("id", activityId);

      if (error) throw error;
      toast.success("Activity completed");
      await fetchActivities();
    } catch (error) {
      console.error("Failed to mark as done:", error);
      toast.error("Failed to complete activity");
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(activityId);
        return next;
      });
    }
  };

  const getActivityStatus = (activity: ActivityWithLead) => {
    if (activity.is_done) return "completed";
    if (!activity.due_date) return "scheduled";
    const dueDate = parseISO(activity.due_date);
    if (isPast(dueDate) && !isToday(dueDate)) return "overdue";
    if (isToday(dueDate)) return "today";
    if (isTomorrow(dueDate)) return "tomorrow";
    return "scheduled";
  };

  const pendingActivities = activities.filter((a) => !a.is_done);
  const completedActivities = activities.filter((a) => a.is_done);

  const overdueActivities = pendingActivities.filter(
    (a) => getActivityStatus(a) === "overdue"
  );
  const todayActivities = pendingActivities.filter(
    (a) => getActivityStatus(a) === "today"
  );
  const upcomingActivities = pendingActivities.filter(
    (a) => getActivityStatus(a) === "scheduled" || getActivityStatus(a) === "tomorrow"
  );

  const renderActivityCard = (activity: ActivityWithLead) => {
    const status = getActivityStatus(activity);
    const isProcessing = processingIds.has(activity.id);

    return (
      <Card
        key={activity.id}
        className={cn(
          "transition-all hover:shadow-md",
          status === "overdue" && "border-destructive/50 bg-destructive/5",
          status === "today" && "border-primary/50 bg-primary/5",
          status === "completed" && "opacity-60"
        )}
      >
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            {!activity.is_done && (
              <Checkbox
                checked={false}
                onCheckedChange={() => markAsDone(activity.id)}
                disabled={isProcessing}
                className="mt-1"
              />
            )}
            {activity.is_done && (
              <CheckCircle2 className="h-5 w-5 text-green-500 mt-1" />
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                {activity.activity_type && (
                  <span className="text-muted-foreground">
                    {ICON_MAP[activity.activity_type] || <Calendar className="h-4 w-4" />}
                  </span>
                )}
                <span className={cn(
                  "font-medium",
                  activity.is_done && "line-through"
                )}>
                  {activity.summary}
                </span>
                {status === "overdue" && (
                  <Badge variant="destructive" className="text-xs">
                    <AlertCircle className="h-3 w-3 mr-1" />
                    Overdue
                  </Badge>
                )}
                {status === "today" && (
                  <Badge className="text-xs bg-primary">
                    Today
                  </Badge>
                )}
              </div>

              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <button
                  onClick={() => navigate(`/crm-app/pipeline?lead=${activity.lead_id}`)}
                  className="flex items-center gap-1 hover:text-primary transition-colors"
                >
                  <ArrowRight className="h-3 w-3" />
                  {activity.lead?.name}
                  {activity.lead?.company_contact?.name && (
                    <span className="text-xs">({activity.lead.company_contact.name})</span>
                  )}
                </button>

                {activity.due_date && (
                  <div className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {format(parseISO(activity.due_date), "MMM d, yyyy")}
                    {activity.due_time && ` at ${activity.due_time}`}
                  </div>
                )}

                {activity.duration && (
                  <span>{activity.duration} min</span>
                )}
              </div>

              {activity.description && (
                <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
                  {activity.description}
                </p>
              )}

              {activity.outcome && (
                <p className="text-sm text-muted-foreground mt-2 italic">
                  Outcome: {activity.outcome}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  if (isLoading) {
    return (
      <>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div>
          <h1 className="font-bold tracking-tight text-2xl">My Activities</h1>
          <p className="text-muted-foreground">
            Track and manage your scheduled activities across all leads
          </p>
        </div>

        {/* Stats - fluid layout that wraps and shows full values */}
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
          <Card className="border-l-4 border-l-destructive">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Overdue</CardTitle>
                <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="stat-value text-destructive tabular-nums whitespace-nowrap">
                {overdueActivities.length}
              </div>
            </CardContent>
          </Card>
          <Card className="border-l-4 border-l-primary">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Today</CardTitle>
                <Calendar className="h-4 w-4 text-primary shrink-0" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="stat-value text-primary tabular-nums whitespace-nowrap">{todayActivities.length}</div>
            </CardContent>
          </Card>
          <Card className="border-l-4 border-l-amber-400">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Upcoming</CardTitle>
                <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="stat-value text-amber-600 tabular-nums whitespace-nowrap">{upcomingActivities.length}</div>
            </CardContent>
          </Card>
          <Card className="border-l-4 border-l-emerald-500">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Completed</CardTitle>
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="stat-value text-emerald-600 tabular-nums whitespace-nowrap">{completedActivities.length}</div>
            </CardContent>
          </Card>
        </div>


        <Tabs defaultValue="pending" className="w-full">
          <TabsList>
            <TabsTrigger value="pending" className="flex items-center gap-2">
              Pending
              <Badge variant="secondary">{pendingActivities.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="completed" className="flex items-center gap-2">
              Completed
              <Badge variant="secondary">{completedActivities.length}</Badge>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pending" className="space-y-6 mt-4">
            {pendingActivities.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <CheckCircle2 className="h-12 w-12 text-green-500 mb-4" />
                  <h3 className="text-lg font-semibold mb-2">All caught up!</h3>
                  <p className="text-muted-foreground">
                    No pending activities. Schedule activities from the lead details page.
                  </p>
                  <Button
                    variant="outline"
                    className="mt-4"
                    onClick={() => navigate("/crm-app/pipeline")}
                  >
                    Go to Pipeline
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <>
                {/* Overdue Section */}
                {overdueActivities.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium text-destructive flex items-center gap-2">
                      <AlertCircle className="h-4 w-4" />
                      Overdue ({overdueActivities.length})
                    </h3>
                    <div className="space-y-2">
                      {overdueActivities.map(renderActivityCard)}
                    </div>
                  </div>
                )}

                {/* Today Section */}
                {todayActivities.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium text-primary flex items-center gap-2">
                      <Calendar className="h-4 w-4" />
                      Today ({todayActivities.length})
                    </h3>
                    <div className="space-y-2">
                      {todayActivities.map(renderActivityCard)}
                    </div>
                  </div>
                )}

                {/* Upcoming Section */}
                {upcomingActivities.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                      <Clock className="h-4 w-4" />
                      Upcoming ({upcomingActivities.length})
                    </h3>
                    <div className="space-y-2">
                      {upcomingActivities.map(renderActivityCard)}
                    </div>
                  </div>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="completed" className="space-y-2 mt-4">
            {completedActivities.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <Calendar className="h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No completed activities</h3>
                  <p className="text-muted-foreground">
                    Completed activities will appear here
                  </p>
                </CardContent>
              </Card>
            ) : (
              completedActivities.slice(0, 20).map(renderActivityCard)
            )}
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
