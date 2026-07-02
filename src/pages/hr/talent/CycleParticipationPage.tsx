/**
 * Cycle Participation Matrix — for a chosen cycle, render every employee
 * across each audience (self / manager / peer / skip_level) the cycle
 * template enables, with the corresponding review status (or "missing").
 *
 * HR uses this to:
 *  - see who is overdue or hasn't been launched yet,
 *  - launch the missing reviews in bulk for selected employees,
 *  - drill into any individual review.
 *
 * Pattern lifted from how big HRIS platforms render their "cycle dashboard":
 * employees as rows, audiences as columns, colored chips per cell.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTalentCycles } from "@/hooks/useTalent";
import { useReviewTemplates, useReviews } from "@/hooks/useReviews";
import { useEmployees } from "@/hooks/useEmployees";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Rocket, AlertTriangle, CheckCircle2, Clock, MinusCircle } from "lucide-react";

type Audience = "self" | "manager" | "peer" | "skip_level";

const ALL_AUDIENCES: Audience[] = ["self", "manager", "peer", "skip_level"];

export default function CycleParticipationPage() {
  const { cycleId } = useParams();
  const { cycles } = useTalentCycles();
  const { templates } = useReviewTemplates();
  const { employees } = useEmployees();
  const { reviews, isLoading, launchReviews } = useReviews({ cycleId });

  const cycle = cycles.find((c) => c.id === cycleId);
  const [templateId, setTemplateId] = useState<string>("");
  const [deptFilter, setDeptFilter] = useState<string>("__all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Use the cycle's default template if set, otherwise the first template.
  const effectiveTemplateId = templateId || cycle?.default_template_id || templates[0]?.id || "";
  const template = templates.find((t) => t.id === effectiveTemplateId);

  const enabledAudiences: Audience[] = useMemo(() => {
    if (!template) return ["self", "manager"];
    const a: Audience[] = [];
    if (template.includes_self) a.push("self");
    if (template.includes_manager) a.push("manager");
    if (template.includes_peer) a.push("peer");
    if (template.includes_skip_level) a.push("skip_level");
    return a.length ? a : ["self", "manager"];
  }, [template]);

  const departments = useMemo(() => {
    const map = new Map<string, string>();
    (employees ?? []).forEach((e: any) => {
      if (e.department_id) map.set(e.department_id, e.department_name || e.department || "—");
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [employees]);

  const visibleEmployees = useMemo(() => {
    const s = search.toLowerCase();
    return (employees ?? [])
      .filter((e: any) => e.is_active !== false)
      .filter((e: any) => deptFilter === "__all" || e.department_id === deptFilter)
      .filter((e: any) =>
        `${e.first_name ?? ""} ${e.last_name ?? ""} ${e.email ?? ""}`.toLowerCase().includes(s),
      );
  }, [employees, search, deptFilter]);

  // Index reviews by (employee_id, review_type).
  const reviewMap = useMemo(() => {
    const m = new Map<string, any>();
    reviews.forEach((r: any) => m.set(`${r.employee_id}::${r.review_type}`, r));
    return m;
  }, [reviews]);

  // Counts for the header summary.
  const summary = useMemo(() => {
    let launched = 0, submitted = 0, overdue = 0, missing = 0;
    const now = Date.now();
    visibleEmployees.forEach((emp: any) => {
      enabledAudiences.forEach((a) => {
        const r = reviewMap.get(`${emp.id}::${a}`);
        if (!r) { missing++; return; }
        launched++;
        if (["submitted", "calibrated", "signed_off", "acknowledged"].includes(r.status)) submitted++;
        else if (r.due_at && new Date(r.due_at).getTime() < now) overdue++;
      });
    });
    return { launched, submitted, overdue, missing, cells: visibleEmployees.length * enabledAudiences.length };
  }, [visibleEmployees, enabledAudiences, reviewMap]);

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function launchMissing() {
    if (!cycle || !effectiveTemplateId || selected.size === 0) return;
    await launchReviews.mutateAsync({
      cycle_id: cycle.id,
      template_id: effectiveTemplateId,
      employee_ids: Array.from(selected),
      due_at: cycle.manager_review_due_at ?? cycle.self_review_due_at ?? null,
    });
    setSelected(new Set());
  }

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm">
        <Link to="/hr/talent/cycles"><ArrowLeft className="h-4 w-4 mr-1" /> Back to cycles</Link>
      </Button>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Participation matrix</h1>
          <p className="text-sm text-muted-foreground">
            {cycle ? <>Cycle <strong>{cycle.name}</strong> — {cycle.period_start} → {cycle.period_end}</> : "Cycle not found"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={launchMissing} disabled={!cycle || !effectiveTemplateId || selected.size === 0 || launchReviews.isPending}>
            <Rocket className="h-4 w-4 mr-1" /> Launch missing ({selected.size})
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <Stat label="Employees" value={visibleEmployees.length} />
        <Stat label="Audience cells" value={summary.cells} />
        <Stat label="Launched" value={summary.launched} tone="default" />
        <Stat label="Submitted" value={summary.submitted} tone="default" />
        <Stat label="Overdue" value={summary.overdue} tone="warn" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
          <CardDescription>Pick a template (drives which audiences are columns) and narrow the employee list.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-3 gap-3">
            <div>
              <Label className="text-xs">Template</Label>
              <Select value={effectiveTemplateId} onValueChange={setTemplateId}>
                <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Pick a template" /></SelectTrigger>
                <SelectContent>
                  {templates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Department</Label>
              <Select value={deptFilter} onValueChange={setDeptFilter}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">All departments</SelectItem>
                  {departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Search</Label>
              <Input className="h-9" placeholder="Name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0 overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide">
              <tr>
                <th className="w-8 px-3 py-2 text-left">
                  <Checkbox
                    checked={visibleEmployees.length > 0 && selected.size === visibleEmployees.length}
                    onCheckedChange={(v) => setSelected(v ? new Set(visibleEmployees.map((e: any) => e.id)) : new Set())}
                  />
                </th>
                <th className="px-3 py-2 text-left">Employee</th>
                <th className="px-3 py-2 text-left">Department</th>
                <th className="px-3 py-2 text-left">Manager?</th>
                {enabledAudiences.map((a) => (
                  <th key={a} className="px-3 py-2 text-left capitalize">{a.replace("_", " ")}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading ? (
                <tr><td colSpan={4 + enabledAudiences.length} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
              ) : visibleEmployees.length === 0 ? (
                <tr><td colSpan={4 + enabledAudiences.length} className="px-3 py-6 text-center text-muted-foreground">No employees match these filters.</td></tr>
              ) : visibleEmployees.map((emp: any) => (
                <tr key={emp.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <Checkbox checked={selected.has(emp.id)} onCheckedChange={() => toggle(emp.id)} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{emp.first_name} {emp.last_name}</div>
                    <div className="text-xs text-muted-foreground">{emp.email}</div>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{emp.department_name || emp.department || "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{emp.manager_id ? "Yes" : <span className="text-amber-600">No manager</span>}</td>
                  {enabledAudiences.map((a) => (
                    <td key={a} className="px-3 py-2">
                      <Cell review={reviewMap.get(`${emp.id}::${a}`)} audience={a} hasManager={!!emp.manager_id} hasUser={!!emp.user_id} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function Cell({ review, audience, hasManager, hasUser }: { review: any; audience: Audience; hasManager: boolean; hasUser: boolean }) {
  if (!review) {
    // Explain why it's missing.
    if (audience === "self" && !hasUser) return <Tag tone="muted" icon={<MinusCircle className="h-3 w-3" />}>No user</Tag>;
    if (audience === "manager" && !hasManager) return <Tag tone="muted" icon={<MinusCircle className="h-3 w-3" />}>No manager</Tag>;
    return <Tag tone="warn" icon={<AlertTriangle className="h-3 w-3" />}>Missing</Tag>;
  }
  const overdue = review.due_at && new Date(review.due_at).getTime() < Date.now() &&
    !["submitted", "calibrated", "signed_off", "acknowledged"].includes(review.status);
  const done = ["submitted", "calibrated", "signed_off", "acknowledged"].includes(review.status);
  const tone = overdue ? "warn" : done ? "ok" : "default";
  const icon = overdue ? <AlertTriangle className="h-3 w-3" /> : done ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />;
  return (
    <Link to={`/hr/talent/reviews/${review.id}`}>
      <Tag tone={tone} icon={icon}>{review.status.replace(/_/g, " ")}</Tag>
    </Link>
  );
}

function Tag({ children, tone, icon }: { children: React.ReactNode; tone: "ok" | "warn" | "default" | "muted"; icon?: React.ReactNode }) {
  const cls =
    tone === "ok" ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/30" :
    tone === "warn" ? "bg-amber-500/10 text-amber-600 border-amber-500/30" :
    tone === "muted" ? "bg-muted text-muted-foreground border-border" :
    "bg-secondary text-secondary-foreground border-border";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${cls}`}>
      {icon}{children}
    </span>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warn" | "default" }) {
  return (
    <div className={`rounded-md border bg-card p-3 ${tone === "warn" && value > 0 ? "border-amber-500/40" : ""}`}>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
