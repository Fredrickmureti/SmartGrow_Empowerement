/**
 * My Development Plan — employee view.
 *
 * Shows the latest active plan (and any earlier ones) and lets the employee
 * tick items off / mark progress. Updates notify the manager.
 */
import { Link } from "react-router-dom";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useDevelopmentPlans, useDevelopmentPlan } from "@/hooks/useDevelopmentPlans";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, PenTool, CheckCircle2, Circle, AlertCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { format } from "date-fns";
import { PageHeader, PageBody, LoadingState, EmptyState } from "@/design-system";

export default function MyDevelopmentPlan() {
  const { currentEmployee } = useCurrentEmployee();
  const { plans, isLoading } = useDevelopmentPlans({ employeeId: currentEmployee?.id });
  const visiblePlans = useMemo(() => plans.filter((p) => p.status !== "draft"), [plans]);
  const [openPlanId, setOpenPlanId] = useState<string | null>(null);

  const activePlanId = openPlanId && visiblePlans.find((p) => p.id === openPlanId)
    ? openPlanId
    : visiblePlans.find((p) => p.status === "active")?.id ?? visiblePlans[0]?.id ?? null;

  if (!currentEmployee) {
    return (
      <>
        <PageHeader title="My development plan" description="Requires a linked employee record." />
        <PageBody><EmptyState icon={PenTool} title="No linked employee record" description="Ask your HR admin to link your account." /></PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="My development plan"
        description="Actions agreed with your manager — built from competency gaps, reviews, and growth goals."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link to="/me/talent"><ArrowLeft className="h-4 w-4 mr-1" /> Back to my talent</Link>
          </Button>
        }
      />
      <PageBody>
      {isLoading ? (
        <LoadingState rows={3} />
      ) : visiblePlans.length === 0 ? (
        <EmptyState icon={PenTool} title="No development plan yet" description="Your manager hasn't activated a plan for you. After your next review, this is where it will appear." />
      ) : (
        <>
          {visiblePlans.length > 1 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Plan:</span>
              <Select value={activePlanId ?? undefined} onValueChange={(v) => setOpenPlanId(v)}>
                <SelectTrigger className="h-8 w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {visiblePlans.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title} · {p.status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {activePlanId && <MyPlanBody planId={activePlanId} />}
        </>
      )}
      </PageBody>
    </>
  );
}

function MyPlanBody({ planId }: { planId: string }) {
  const { plan, items, isLoading, updateItem } = useDevelopmentPlan(planId);

  const completion = useMemo(() => {
    if (items.length === 0) return 0;
    return Math.round(items.reduce((a, i) => a + (Number(i.progress_pct) || 0), 0) / items.length);
  }, [items]);

  if (!plan) return <p className="text-sm text-muted-foreground">Loading plan…</p>;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{plan.title}</CardTitle>
            {plan.summary && <CardDescription className="mt-1">{plan.summary}</CardDescription>}
          </div>
          <Badge variant="outline" className="text-[10px]">
            {plan.status.replace(/_/g, " ")}
          </Badge>
        </div>
        <div className="mt-3 space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Overall progress</span>
            <span className="tabular-nums">{completion}%</span>
          </div>
          <Progress value={completion} className="h-1.5" />
          {plan.target_completion_date && (
            <p className="text-[11px] text-muted-foreground mt-1">
              Target completion: {format(new Date(plan.target_completion_date), "MMM d, yyyy")}
            </p>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading actions…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No actions in this plan yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {items.map((it) => (
              <li key={it.id} className="px-3 py-2 flex items-start gap-3">
                <button
                  className="mt-0.5 shrink-0"
                  onClick={() =>
                    updateItem.mutate({
                      id: it.id,
                      patch: {
                        status: it.status === "completed" ? "in_progress" : "completed",
                        progress_pct: it.status === "completed" ? 50 : 100,
                      },
                      notify: true,
                    })
                  }
                  title={it.status === "completed" ? "Reopen" : "Mark complete"}
                >
                  {it.status === "completed" ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                  ) : it.status === "blocked" ? (
                    <AlertCircle className="h-5 w-5 text-amber-600" />
                  ) : (
                    <Circle className="h-5 w-5 text-muted-foreground" />
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={
                        "text-sm font-medium " +
                        (it.status === "completed" ? "line-through text-muted-foreground" : "")
                      }
                    >
                      {it.title}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {it.item_type.replace(/_/g, " ")}
                    </Badge>
                    {it.due_date && (
                      <span className="text-[10px] text-muted-foreground">
                        due {format(new Date(it.due_date), "MMM d")}
                      </span>
                    )}
                  </div>
                  {it.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 whitespace-pre-wrap">
                      {it.description}
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <Progress value={Number(it.progress_pct) || 0} className="h-1 flex-1 max-w-[180px]" />
                    <Select
                      value={it.status}
                      onValueChange={(v) =>
                        updateItem.mutate({
                          id: it.id,
                          patch: { status: v as any },
                          notify: v === "completed",
                        })
                      }
                    >
                      <SelectTrigger className="h-6 w-[120px] text-[11px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="not_started">Not started</SelectItem>
                        <SelectItem value="in_progress">In progress</SelectItem>
                        <SelectItem value="blocked">Blocked</SelectItem>
                        <SelectItem value="completed">Completed</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
