/**
 * Talent Dashboard — landing for HR/Managers entering the Talent app.
 *
 * Surfaces the things you can *act on right now*: active cycle, goals at
 * risk, overdue check-ins, employees with no goals this cycle, and quick
 * links into the deeper workflows.
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTalentCycles, useTalentGoals } from "@/hooks/useTalent";
import { useEmployees } from "@/hooks/useEmployees";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Target, AlertCircle, TrendingUp, Users, ArrowRight, CalendarCheck } from "lucide-react";

export default function TalentDashboard() {
  const { cycles } = useTalentCycles();
  const activeCycle = useMemo(
    () => cycles.find((c) => c.phase !== "closed") ?? cycles[0] ?? null,
    [cycles],
  );
  const { goals } = useTalentGoals({ cycleId: activeCycle?.id });
  const { employees } = useEmployees();

  const atRisk = goals.filter((g) => g.status === "at_risk").length;
  const overdueCheckins = useMemo(() => {
    const now = Date.now();
    return goals.filter((g) => g.next_check_in_due_at && new Date(g.next_check_in_due_at).getTime() < now).length;
  }, [goals]);
  const noGoals = useMemo(() => {
    if (!activeCycle) return 0;
    const withGoal = new Set(goals.map((g) => g.employee_id));
    return employees.filter((e) => e.is_active !== false && !withGoal.has(e.id)).length;
  }, [activeCycle, goals, employees]);
  const avgProgress = goals.length
    ? Math.round(goals.reduce((a, g) => a + (g.progress_pct ?? 0), 0) / goals.length)
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Talent</h1>
          <p className="text-sm text-muted-foreground">
            Performance cycles, goals, competencies, reviews, and development plans.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline"><Link to="/hr/talent/cycles">Cycles</Link></Button>
          <Button asChild><Link to="/hr/talent/goals">Manage goals</Link></Button>
        </div>
      </div>

      {/* Active cycle banner */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarCheck className="h-5 w-5 text-primary" />
            {activeCycle ? activeCycle.name : "No active cycle"}
          </CardTitle>
          <CardDescription>
            {activeCycle
              ? <>Phase: <Badge variant="secondary" className="ml-1">{activeCycle.phase.replace(/_/g, " ")}</Badge> · {activeCycle.period_start} → {activeCycle.period_end}</>
              : "Create a performance cycle to start setting goals and launching reviews."}
          </CardDescription>
        </CardHeader>
        {!activeCycle ? (
          <CardContent>
            <Button asChild><Link to="/hr/talent/cycles">Create your first cycle <ArrowRight className="h-4 w-4 ml-1" /></Link></Button>
          </CardContent>
        ) : null}
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Active goals" value={goals.length} icon={Target} />
        <Stat label="At risk" value={atRisk} icon={AlertCircle} tone={atRisk > 0 ? "warn" : undefined} />
        <Stat label="Overdue check-ins" value={overdueCheckins} icon={AlertCircle} tone={overdueCheckins > 0 ? "warn" : undefined} />
        <Stat label="Avg progress" value={`${avgProgress}%`} icon={TrendingUp} />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" /> Employees without goals
            </CardTitle>
            <CardDescription>People with no goal in the active cycle.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{noGoals}</p>
            <Button asChild variant="link" className="px-0">
              <Link to="/hr/talent/goals">Assign goals <ArrowRight className="h-4 w-4 ml-1" /></Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Next steps</CardTitle>
            <CardDescription>The Talent system runs as a single workflow — keep it moving.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <NextStep to="/hr/talent/cycles" label="Set up or advance the active performance cycle" />
            <NextStep to="/hr/talent/goals" label="Assign / cascade goals to every active employee" />
            <NextStep to="/hr/talent/competencies" label="Define role competencies" />
            <NextStep to="/hr/talent/reviews" label="Launch self & manager reviews" />
            <NextStep to="/hr/talent/development" label="Build development plans from gaps" />
            <NextStep to="/hr/talent/nine-box" label="Calibrate the 9-box talent grid" />
            <NextStep to="/hr/talent/succession" label="Plan succession for critical roles" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, icon: Icon, tone }: { label: string; value: React.ReactNode; icon: any; tone?: "warn" }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className={"text-2xl font-semibold " + (tone === "warn" ? "text-destructive" : "")}>{value}</p>
          </div>
          <Icon className={"h-5 w-5 " + (tone === "warn" ? "text-destructive" : "text-muted-foreground")} />
        </div>
      </CardContent>
    </Card>
  );
}

function NextStep({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="flex items-center justify-between rounded-md border px-3 py-2 hover:bg-accent">
      <span>{label}</span>
      <ArrowRight className="h-4 w-4 text-muted-foreground" />
    </Link>
  );
}
