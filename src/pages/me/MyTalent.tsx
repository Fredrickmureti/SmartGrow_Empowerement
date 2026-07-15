/**
 * My Talent — employee landing for the Talent app.
 *
 * Shows the employee's active goals, latest manager feedback, upcoming
 * check-ins, and pending review actions. This is the answer to "what does
 * the employee see?" — the same data the manager sees in /hr/talent, but
 * scoped to themselves and shaped for action, not administration.
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useTalentGoals } from "@/hooks/useTalent";
import { useReviews } from "@/hooks/useReviews";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Target, ChevronRight, AlertCircle, ClipboardList, Award, PenTool, MessageSquare, CalendarClock } from "lucide-react";
import { PageHeader, PageBody, LoadingState, EmptyState } from "@/design-system";

export default function MyTalent() {
  const { user } = useAuth();
  const { currentEmployee } = useCurrentEmployee();
  const { goals, isLoading } = useTalentGoals({ employeeId: currentEmployee?.id });
  const { reviews: toFillReviews } = useReviews({ reviewerUserId: user?.id });

  const active = useMemo(() => goals.filter((g) => g.status !== "completed" && g.status !== "cancelled"), [goals]);
  const overdue = useMemo(() => {
    const now = Date.now();
    return active.filter((g) => g.next_check_in_due_at && new Date(g.next_check_in_due_at).getTime() < now);
  }, [active]);
  const pendingReviews = useMemo(
    () => toFillReviews.filter((r) => r.status === "draft" || r.status === "in_progress").length,
    [toFillReviews],
  );

  if (!currentEmployee) {
    return (
      <>
        <PageHeader title="My talent" description="Talent features require a linked employee record." />
        <PageBody><EmptyState icon={Target} title="No linked employee record" description="Ask your HR admin to link your account to your employee profile." /></PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader title="My talent" description="Your goals, reviews, competencies, and growth plan in one place." />
      <PageBody>
      {/* Quick stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile icon={Target}      label="Active goals"     value={active.length} />
        <Tile icon={AlertCircle} label="Check-ins due"   value={overdue.length} tone={overdue.length ? "warn" : undefined} />
        <Tile icon={ClipboardList} label="Pending reviews" value={pendingReviews} tone={pendingReviews ? "warn" : undefined} />
        <Link to="/me/talent/competencies"><Tile icon={Award} label="Competencies" value="Open →" /></Link>
      </div>

      {/* My goals */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2"><Target className="h-4 w-4" /> My goals</CardTitle>
            <CardDescription>Update progress, log check-ins, and read your manager's feedback.</CardDescription>
          </div>
          <Button asChild variant="ghost" size="sm"><Link to="/me/talent/goals">View all</Link></Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading ? <LoadingState rows={3} /> :
           active.length === 0 ? (
            <p className="text-sm text-muted-foreground">You have no active goals. Your manager will assign goals when the current cycle opens.</p>
          ) : active.slice(0, 5).map((g) => (
            <Link key={g.id} to={`/me/talent/goals/${g.id}`} className="flex items-center gap-3 rounded-md border px-3 py-2 hover:bg-accent">
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{g.title}</p>
                <div className="flex items-center gap-2 mt-1">
                  <Progress value={g.progress_pct ?? 0} className="h-1.5 max-w-[180px]" />
                  <span className="text-xs text-muted-foreground tabular-nums">{Math.round(g.progress_pct ?? 0)}%</span>
                  <Badge variant="outline" className="text-[10px]">{g.status.replace(/_/g, " ")}</Badge>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </Link>
          ))}
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><ClipboardList className="h-4 w-4" /> Reviews</CardTitle>
            <CardDescription>Self review, manager review, and your sign-off.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" size="sm"><Link to="/me/talent/reviews">Open my reviews <ChevronRight className="h-4 w-4 ml-1" /></Link></Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><PenTool className="h-4 w-4" /> Development plan</CardTitle>
            <CardDescription>What you'll work on next, based on your reviews & gaps.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" size="sm">
              <Link to="/me/talent/development">Open my plan <ChevronRight className="h-4 w-4 ml-1" /></Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><MessageSquare className="h-4 w-4" /> Feedback & kudos</CardTitle>
            <CardDescription>Continuous praise, constructive feedback, and recognition.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" size="sm"><Link to="/me/talent/feedback">Open feedback <ChevronRight className="h-4 w-4 ml-1" /></Link></Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><CalendarClock className="h-4 w-4" /> 1:1 meetings</CardTitle>
            <CardDescription>Recurring conversations with your manager and team.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" size="sm"><Link to="/me/one-on-ones">Open 1:1s <ChevronRight className="h-4 w-4 ml-1" /></Link></Button>
          </CardContent>
        </Card>
      </div>
      </PageBody>
    </>
  );
}

function Tile({ icon: Icon, label, value, tone, hint }: { icon: any; label: string; value: React.ReactNode; tone?: "warn"; hint?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className={"text-2xl font-semibold " + (tone === "warn" ? "text-destructive" : "")}>{value}</p>
            {hint ? <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p> : null}
          </div>
          <Icon className={"h-5 w-5 " + (tone === "warn" ? "text-destructive" : "text-muted-foreground")} />
        </div>
      </CardContent>
    </Card>
  );
}
