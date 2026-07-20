/**
 * TalentAnalyticsPage — Phase D executive Talent dashboard.
 *
 * Mounted at `/hr/talent/analytics`. Surfaces per-department rollups for:
 *   - review completion, average rating, rating distribution
 *   - succession bench depth (key roles + readiness)
 *   - learning compliance
 *   - competency gap heatmap
 *
 * All data is read from RLS-scoped views — what an HR or exec user sees here
 * is exactly what they can already see in the underlying lists.
 */
import { useMemo } from "react";
import { useExecutiveTalent, useCompetencyGapHeatmap } from "@/hooks/useTalentAnalytics";
import { useEmployees } from "@/hooks/useEmployees";
import { useCompetencies } from "@/hooks/useCompetencyFramework";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell, CartesianGrid } from "recharts";
import { Users, Star, ClipboardCheck, BookOpen, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/hooks/useOrganization";

interface DepartmentRow { id: string; name: string }

export default function TalentAnalyticsPage() {
  const { rows, isLoading } = useExecutiveTalent();
  const { rows: gapRows } = useCompetencyGapHeatmap();
  const { currentOrg } = useOrganization();

  const { data: departments = [] } = useQuery({
    queryKey: ["departments-min", currentOrg?.id],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from("departments")
        .select("id, name")
        .eq("organization_id", currentOrg!.id);
      return (data as DepartmentRow[]) ?? [];
    },
  });
  const deptName = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments]);

  const { competencies } = useCompetencies();
  const compName = useMemo(() => new Map(competencies.map((c: any) => [c.id, c.name])), [competencies]);

  // Org totals
  const totals = useMemo(() => {
    const hc = rows.reduce((s, r) => s + (r.headcount ?? 0), 0);
    const rd = rows.reduce((s, r) => s + (r.reviews_done ?? 0), 0);
    const rt = rows.reduce((s, r) => s + (r.reviews_total ?? 0), 0);
    const la = rows.reduce((s, r) => s + (r.learning_assigned ?? 0), 0);
    const lc = rows.reduce((s, r) => s + (r.learning_completed ?? 0), 0);
    const kr = rows.reduce((s, r) => s + (r.succession_key_roles ?? 0), 0);
    const rn = rows.reduce((s, r) => s + (r.successors_ready_now ?? 0), 0);
    const ratings = rows.filter((r) => r.avg_rating != null);
    const avg = ratings.length ? ratings.reduce((s, r) => s + (r.avg_rating ?? 0), 0) / ratings.length : null;
    return { hc, rd, rt, la, lc, kr, rn, avg };
  }, [rows]);

  // Aggregate rating distribution across departments
  const distData = useMemo(() => {
    const acc: Record<string, number> = {};
    rows.forEach((r) => {
      if (!r.rating_distribution) return;
      Object.entries(r.rating_distribution).forEach(([bucket, n]) => {
        acc[bucket] = (acc[bucket] ?? 0) + (n as number);
      });
    });
    return Object.entries(acc)
      .map(([rating, count]) => ({ rating: `${rating}★`, count }))
      .sort((a, b) => a.rating.localeCompare(b.rating));
  }, [rows]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Talent Analytics</h1>
        <p className="text-sm text-muted-foreground">Executive view of performance, succession, and learning across the organization.</p>
      </div>

      {/* Org totals */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Metric icon={<Users className="h-4 w-4" />} label="Active employees" value={totals.hc} />
        <Metric icon={<ClipboardCheck className="h-4 w-4" />} label="Review completion" value={totals.rt ? `${Math.round((totals.rd / totals.rt) * 100)}%` : "—"} subtitle={`${totals.rd} of ${totals.rt}`} />
        <Metric icon={<Star className="h-4 w-4" />} label="Average rating" value={totals.avg != null ? totals.avg.toFixed(2) : "—"} />
        <Metric icon={<BookOpen className="h-4 w-4" />} label="Learning compliance" value={totals.la ? `${Math.round((totals.lc / totals.la) * 100)}%` : "—"} subtitle={`${totals.lc} of ${totals.la}`} />
        <Metric icon={<ShieldCheck className="h-4 w-4" />} label="Bench (ready now)" value={`${totals.rn} / ${totals.kr}`} subtitle="key roles covered" />
      </div>

      {/* Rating distribution */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rating distribution</CardTitle>
          <CardDescription>Active cycle, all departments combined.</CardDescription>
        </CardHeader>
        <CardContent>
          {distData.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No ratings recorded yet for the active cycle.</p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={distData}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="rating" />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {distData.map((_, i) => (
                      <Cell key={i} fill={["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6"][i % 5]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-department table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">By department</CardTitle>
          <CardDescription>Completion, ratings, succession bench depth, and learning compliance.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr>
                <th className="text-left py-2 pr-3">Department</th>
                <th className="text-right py-2 px-3">Headcount</th>
                <th className="text-right py-2 px-3">Reviews</th>
                <th className="text-right py-2 px-3">Avg rating</th>
                <th className="text-right py-2 px-3">Bench (now / 1-2y / 3-5y)</th>
                <th className="text-right py-2 pl-3">Learning</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={6} className="py-6 text-center text-muted-foreground">Loading…</td></tr>}
              {!isLoading && rows.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-muted-foreground">No data yet.</td></tr>}
              {rows.map((r) => (
                <tr key={r.department_id ?? "no-dept"}>
                  <td className="py-2 pr-3 font-medium">{r.department_id ? deptName.get(r.department_id) ?? "—" : "Unassigned"}</td>
                  <td className="py-2 px-3 text-right">{r.headcount}</td>
                  <td className="py-2 px-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <span className="text-xs text-muted-foreground">{r.reviews_done}/{r.reviews_total}</span>
                      <div className="w-16"><Progress value={r.review_completion_pct ?? 0} /></div>
                    </div>
                  </td>
                  <td className="py-2 px-3 text-right">{r.avg_rating ?? "—"}</td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {r.successors_ready_now} / {r.successors_ready_1_2y} / {r.successors_ready_3_5y}
                    <span className="text-xs text-muted-foreground ml-1">({r.succession_key_roles} roles)</span>
                  </td>
                  <td className="py-2 pl-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <span className="text-xs text-muted-foreground">{r.learning_completed}/{r.learning_assigned}</span>
                      <div className="w-16"><Progress value={r.learning_compliance_pct ?? 0} /></div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Competency gap heatmap */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Competency gaps</CardTitle>
          <CardDescription>Largest gaps between required and current competency levels.</CardDescription>
        </CardHeader>
        <CardContent>
          {gapRows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No competency requirements configured yet.</p>
          ) : (
            <div className="space-y-2">
              {[...gapRows].sort((a, b) => Number(b.gap) - Number(a.gap)).slice(0, 12).map((g) => {
                const gap = Number(g.gap);
                const tone = gap >= 2 ? "bg-red-500/15 text-red-700" : gap >= 1 ? "bg-amber-500/15 text-amber-700" : "bg-emerald-500/15 text-emerald-700";
                return (
                  <div key={`${g.department_id}-${g.competency_id}`} className="flex items-center justify-between gap-3 py-1.5 border-b last:border-0">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{compName.get(g.competency_id) ?? "Competency"}</div>
                      <div className="text-xs text-muted-foreground">{g.department_id ? deptName.get(g.department_id) ?? "—" : "Unassigned"} · {g.employees_evaluated} evaluated · {g.employees_below} below</div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs text-muted-foreground">req {g.avg_required_level} · cur {g.avg_current_level}</span>
                      <Badge className={tone}>gap {gap.toFixed(1)}</Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ icon, label, value, subtitle }: { icon: React.ReactNode; label: string; value: React.ReactNode; subtitle?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">{icon}{label}</div>
        <div className="text-2xl font-semibold mt-1">{value}</div>
        {subtitle && <div className="text-xs text-muted-foreground mt-0.5">{subtitle}</div>}
      </CardContent>
    </Card>
  );
}
