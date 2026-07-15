/**
 * My Goals — employee list of own goals with quick progress + check-in.
 */
import { Link } from "react-router-dom";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useTalentGoals } from "@/hooks/useTalent";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ChevronRight, Target } from "lucide-react";
import { PageHeader, PageBody, LoadingState, EmptyState } from "@/design-system";

export default function MyGoals() {
  const { currentEmployee } = useCurrentEmployee();
  const { goals, isLoading } = useTalentGoals({ employeeId: currentEmployee?.id });

  if (!currentEmployee) return null;

  return (
    <>
      <PageHeader title="My goals" description="All goals assigned to you. Click any goal to update progress or read feedback." />
      <PageBody>
      {isLoading ? <LoadingState /> :
       goals.length === 0 ? (
        <EmptyState icon={Target} title="No goals yet" description="Your manager will assign goals when the current cycle opens." />
      ) : (
        <div className="grid gap-2">
          {goals.map((g) => (
            <Link key={g.id} to={`/me/talent/goals/${g.id}`}>
              <Card className="hover:bg-accent transition">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="text-base truncate">{g.title}</CardTitle>
                      <CardDescription className="line-clamp-1">{g.description ?? ""}</CardDescription>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
                  </div>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-3 text-xs">
                  <div className="flex items-center gap-2 flex-1 min-w-[160px]">
                    <Progress value={g.progress_pct ?? 0} className="h-1.5 max-w-[200px]" />
                    <span className="tabular-nums text-muted-foreground">{Math.round(g.progress_pct ?? 0)}%</span>
                  </div>
                  <Badge variant="outline">{g.status.replace(/_/g, " ")}</Badge>
                  <Badge variant="secondary">{g.alignment}</Badge>
                  {g.target_date ? <span className="text-muted-foreground">Due {g.target_date}</span> : null}
                  {g.next_check_in_due_at ? <span className="text-muted-foreground">Check-in: {new Date(g.next_check_in_due_at).toLocaleDateString()}</span> : null}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
      </PageBody>
    </>
  );
}
