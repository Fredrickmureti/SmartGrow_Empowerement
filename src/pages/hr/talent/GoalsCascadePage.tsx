/**
 * Goal Cascade — visual alignment tree of organization/department/team
 * goals down to individual goals via `parent_goal_id`. Lets HR see whether
 * individual goals roll up to anything (orphan = bad) and pick a parent
 * for any goal inline.
 *
 * Filter by cycle; defaults to the most recent active cycle.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTalentCycles, useTalentGoals } from "@/hooks/useTalent";
import { useGoalRollup } from "@/hooks/useGoalRollup";
import { useEmployees } from "@/hooks/useEmployees";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Network, ChevronRight, AlertTriangle, Scale } from "lucide-react";

const ALIGNMENT_ORDER = ["organization", "department", "team", "individual"] as const;

export default function GoalsCascadePage() {
  const { cycles } = useTalentCycles();
  const [cycleId, setCycleId] = useState<string | undefined>(cycles[0]?.id);
  const effectiveCycleId = cycleId ?? cycles[0]?.id;
  const { goals, isLoading, updateGoal } = useTalentGoals({ cycleId: effectiveCycleId });
  const { rows: rollupRows } = useGoalRollup(effectiveCycleId);
  const rollupById = useMemo(() => new Map(rollupRows.map((r) => [r.id, r])), [rollupRows]);
  const { employees } = useEmployees();

  const empName = (id: string) => {
    const e = employees.find((x: any) => x.id === id);
    return e ? `${e.first_name} ${e.last_name}` : id.slice(0, 8);
  };

  const byParent = useMemo(() => {
    const m = new Map<string | null, any[]>();
    goals.forEach((g: any) => {
      const key = g.parent_goal_id ?? null;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(g);
    });
    return m;
  }, [goals]);

  // Roots: goals with no parent OR whose parent is not in this cycle.
  const goalIds = useMemo(() => new Set(goals.map((g: any) => g.id)), [goals]);
  const roots = useMemo(
    () => goals
      .filter((g: any) => !g.parent_goal_id || !goalIds.has(g.parent_goal_id))
      .sort((a: any, b: any) =>
        ALIGNMENT_ORDER.indexOf(a.alignment) - ALIGNMENT_ORDER.indexOf(b.alignment)),
    [goals, goalIds],
  );

  const orphanIndividuals = useMemo(
    () => goals.filter((g: any) => g.alignment === "individual" && !g.parent_goal_id),
    [goals],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Network className="h-5 w-5" /> Goal cascade</h1>
          <p className="text-sm text-muted-foreground">See how individual goals roll up to team, department, and organization goals.</p>
        </div>
        <div className="w-64">
          <Select value={effectiveCycleId} onValueChange={setCycleId}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Cycle" /></SelectTrigger>
            <SelectContent>
              {cycles.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {orphanIndividuals.length > 0 ? (
        <Card className="border-amber-500/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-amber-700">
              <AlertTriangle className="h-4 w-4" /> {orphanIndividuals.length} individual goal{orphanIndividuals.length === 1 ? "" : "s"} not aligned to a parent
            </CardTitle>
            <CardDescription>Individual goals should roll up to a team or department goal so progress aggregates correctly.</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Alignment tree</CardTitle>
          <CardDescription>Click a goal to drill in; use the Parent picker to re-align.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> :
            roots.length === 0 ? (
              <p className="text-sm text-muted-foreground">No goals in this cycle yet.</p>
            ) : (
              <div className="space-y-2">
                {roots.map((r: any) => (
                  <Tree key={r.id} goal={r} depth={0} byParent={byParent} empName={empName}
                        allGoals={goals}
                        rollupById={rollupById}
                        onSetParent={(id, parentId) => updateGoal.mutate({ id, patch: { parent_goal_id: parentId } as any })}
                  />
                ))}
              </div>
            )}
        </CardContent>
      </Card>
    </div>
  );
}

function Tree({ goal, depth, byParent, empName, allGoals, rollupById, onSetParent }: {
  goal: any; depth: number;
  byParent: Map<string | null, any[]>;
  empName: (id: string) => string;
  allGoals: any[];
  rollupById: Map<string, import("@/hooks/useGoalRollup").GoalRollupRow>;
  onSetParent: (id: string, parentId: string | null) => void;
}) {
  const children = byParent.get(goal.id) ?? [];
  const parentOptions = allGoals.filter((g) => g.id !== goal.id);
  const rollup = rollupById.get(goal.id);
  const showRolled = rollup && rollup.child_count > 0 && Math.abs(rollup.rolled_progress - rollup.own_progress) >= 0.5;
  return (
    <div>
      <div
        className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 hover:bg-accent"
        style={{ marginLeft: depth * 20 }}
      >
        {depth > 0 ? <ChevronRight className="h-3 w-3 text-muted-foreground" /> : null}
        <Badge variant="outline" className="capitalize">{goal.alignment}</Badge>
        {rollup?.weight_sum_warning ? (
          <Badge variant="outline" className="text-amber-600 border-amber-300" title={`Children weights sum to ${rollup.child_weight_sum}% (should be 100%)`}>
            <Scale className="h-3 w-3 mr-1" />weights {Number(rollup.child_weight_sum).toFixed(0)}%
          </Badge>
        ) : null}
        {rollup?.is_orphan ? (
          <Badge variant="outline" className="text-amber-600 border-amber-300"><AlertTriangle className="h-3 w-3 mr-1" />orphan</Badge>
        ) : null}
        <Link to={`/hr/talent/goals/${goal.id}`} className="flex-1 min-w-0">
          <span className="font-medium truncate">{goal.title}</span>
          <span className="ml-2 text-xs text-muted-foreground">· {empName(goal.employee_id)}</span>
        </Link>
        <div className="w-24"><Progress value={(showRolled ? rollup!.rolled_progress : (goal.progress_pct ?? 0))} className="h-1.5" /></div>
        <span className="w-10 text-xs text-right tabular-nums">{Math.round((showRolled ? rollup!.rolled_progress : (goal.progress_pct ?? 0)))}%</span>
        {showRolled ? (
          <span className="text-[10px] text-muted-foreground" title={`Own ${rollup!.own_progress}% · rolled ${rollup!.rolled_progress}%`}>rolled</span>
        ) : null}
        <Select
          value={goal.parent_goal_id ?? "__none"}
          onValueChange={(v) => onSetParent(goal.id, v === "__none" ? null : v)}
        >
          <SelectTrigger className="h-7 w-40 text-xs"><SelectValue placeholder="Parent" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none">No parent</SelectItem>
            {parentOptions.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.alignment}: {p.title.slice(0, 40)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {children.length > 0 ? (
        <div className="mt-1 space-y-1">
          {children.map((c: any) => (
            <Tree key={c.id} goal={c} depth={depth + 1} byParent={byParent} empName={empName}
                  allGoals={allGoals} rollupById={rollupById} onSetParent={onSetParent} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
