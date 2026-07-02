/**
 * Succession Planning — per critical role, HR maintains a plan with ranked
 * successors and readiness horizons. Bench-strength view rolls up the
 * org-level coverage picture.
 *
 * Also surfaces Talent Pools (HiPos, retention risks, leadership bench)
 * so HR can manage curated groupings separately from formal succession.
 */
import { useMemo, useState } from "react";
import { useSuccessionPlans, useTalentPools, type Criticality, type SuccessorReadiness, type PoolType, type ReadinessTag } from "@/hooks/useSuccession";
import { useEmployees } from "@/hooks/useEmployees";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TalentFormShell } from "@/components/talent/_shared/TalentFormShell";
import { WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { Crown, Shield, Trash2, UserPlus, Plus } from "lucide-react";

const READINESS_LABEL: Record<SuccessorReadiness, string> = {
  ready_now: "Ready now",
  ready_1_2y: "Ready 1–2y",
  ready_3_5y: "Ready 3–5y",
  emergency_cover: "Emergency cover",
};
const CRIT_TONE: Record<Criticality, string> = {
  critical: "bg-destructive/15 text-destructive border-destructive/30",
  high:     "bg-amber-500/15 text-amber-700 border-amber-500/30",
  medium:   "bg-blue-500/15 text-blue-700 border-blue-500/30",
  low:      "bg-muted text-muted-foreground",
};
const BENCH_TONE: Record<string, string> = {
  strong:     "bg-emerald-500/15 text-emerald-700",
  developing: "bg-blue-500/15 text-blue-700",
  thin:       "bg-amber-500/15 text-amber-700",
  at_risk:    "bg-destructive/15 text-destructive",
};
const POOL_TYPE_LABEL: Record<PoolType, string> = {
  general: "General",
  high_potential: "High Potential",
  critical_role: "Critical Role",
  successor: "Successor Pool",
  retention_risk: "Retention Risk",
  leadership: "Leadership",
};

export default function SuccessionPage() {
  return (
    <Tabs defaultValue="plans" className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Crown className="h-6 w-6 text-primary" /> Succession & Talent Pools
          </h1>
          <p className="text-sm text-muted-foreground">
            Plan continuity for critical roles, and curate strategic talent groupings.
          </p>
        </div>
        <TabsList>
          <TabsTrigger value="plans">Succession Plans</TabsTrigger>
          <TabsTrigger value="pools">Talent Pools</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="plans"><SuccessionPlansTab /></TabsContent>
      <TabsContent value="pools"><TalentPoolsTab /></TabsContent>
    </Tabs>
  );
}

// --------------------------------------------------------------------- Plans
function SuccessionPlansTab() {
  const { plans, successors, benchStrength, createPlan, deletePlan, updatePlan, addSuccessor, removeSuccessor, updateSuccessor } = useSuccessionPlans();
  const { employees } = useEmployees();
  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const benchByPlan = useMemo(() => new Map(benchStrength.map((b) => [b.plan_id, b])), [benchStrength]);
  const successorsByPlan = useMemo(() => {
    const m = new Map<string, typeof successors>();
    for (const s of successors) {
      if (!m.has(s.plan_id)) m.set(s.plan_id, []);
      m.get(s.plan_id)!.push(s);
    }
    return m;
  }, [successors]);

  const totals = useMemo(() => {
    const t = { plans: plans.length, strong: 0, at_risk: 0, ready_now: 0 };
    for (const b of benchStrength) {
      if (b.bench_strength === "strong") t.strong++;
      if (b.bench_strength === "at_risk") t.at_risk++;
      t.ready_now += b.ready_now_count;
    }
    return t;
  }, [plans, benchStrength]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Plans" value={totals.plans} />
        <Kpi label="Strong bench" value={totals.strong} tone="emerald" />
        <Kpi label="At-risk roles" value={totals.at_risk} tone="destructive" />
        <Kpi label="Ready-now candidates" value={totals.ready_now} />
      </div>

      <div className="flex justify-end">
        <NewPlanDialog onCreate={(args) => createPlan.mutateAsync(args)} employees={employees} />
      </div>

      <div className="grid gap-3">
        {plans.length === 0 ? (
          <Card><CardContent className="p-6 text-sm text-muted-foreground">No succession plans yet. Start with your 3–5 most critical roles.</CardContent></Card>
        ) : plans.map((plan) => {
          const bench = benchByPlan.get(plan.id);
          const items = (successorsByPlan.get(plan.id) ?? []).sort((a, b) => a.rank - b.rank);
          const incumbent = plan.incumbent_employee_id ? empById.get(plan.incumbent_employee_id) : null;
          return (
            <Card key={plan.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
                <div className="space-y-1">
                  <CardTitle className="text-base flex items-center gap-2">
                    {plan.role_title}
                    <Badge variant="outline" className={CRIT_TONE[plan.criticality]}>{plan.criticality}</Badge>
                    {bench ? <Badge variant="outline" className={BENCH_TONE[bench.bench_strength]}>{bench.bench_strength.replace("_", " ")}</Badge> : null}
                  </CardTitle>
                  <CardDescription>
                    Incumbent: {incumbent ? `${incumbent.first_name} ${incumbent.last_name}` : "Vacant"} ·
                    Vacancy risk: {plan.vacancy_risk}
                    {plan.notes ? ` · ${plan.notes}` : ""}
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  <AddSuccessorDialog planId={plan.id} employees={employees} onAdd={(args) => addSuccessor.mutateAsync(args)} />
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => deletePlan.mutateAsync(plan.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No successors named yet — the bench is thin.</p>
                ) : items.map((s) => {
                  const e = empById.get(s.employee_id);
                  return (
                    <div key={s.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                      <div className="flex items-center gap-3">
                        <Badge variant="secondary" className="font-mono">#{s.rank}</Badge>
                        <span className="font-medium">{e ? `${e.first_name} ${e.last_name}` : "Unknown"}</span>
                        <Select value={s.readiness} onValueChange={(v) => updateSuccessor.mutate({ id: s.id, patch: { readiness: v as SuccessorReadiness } })}>
                          <SelectTrigger className="h-7 w-[150px] text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {Object.entries(READINESS_LABEL).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={() => removeSuccessor.mutate(s.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function NewPlanDialog({ onCreate, employees }: { onCreate: (args: any) => Promise<any>; employees: any[] }) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState("");
  const [incumbent, setIncumbent] = useState<string>("");
  const [criticality, setCriticality] = useState<Criticality>("high");
  const [risk, setRisk] = useState<"low"|"medium"|"high">("medium");
  const [notes, setNotes] = useState("");

  async function submit() {
    await onCreate({
      role_title: role.trim(),
      incumbent_employee_id: incumbent || null,
      criticality, vacancy_risk: risk, notes: notes || undefined,
    });
    setOpen(false); setRole(""); setIncumbent(""); setNotes(""); setCriticality("high"); setRisk("medium");
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1" /> New plan</Button>
      <TalentFormShell
        open={open}
        onOpenChange={setOpen}
        entity="succession-plan"
        mode="create"
        submitDisabled={!role.trim()}
        submitLabel="Create plan"
        onSubmit={submit}
      >
        <WorkflowSheetSection number={1} title="Role">
          <WorkflowField label="Role title" required>
            <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. VP of Engineering" />
          </WorkflowField>
          <WorkflowField label="Incumbent (optional)">
            <Select value={incumbent} onValueChange={setIncumbent}>
              <SelectTrigger><SelectValue placeholder="Vacant" /></SelectTrigger>
              <SelectContent>
                {employees.map((e) => <SelectItem key={e.id} value={e.id}>{e.first_name} {e.last_name}</SelectItem>)}
              </SelectContent>
            </Select>
          </WorkflowField>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={2} title="Risk profile">
          <WorkflowSheetGrid>
            <WorkflowField label="Criticality">
              <Select value={criticality} onValueChange={(v) => setCriticality(v as Criticality)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="critical">Critical</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </WorkflowField>
            <WorkflowField label="Vacancy risk">
              <Select value={risk} onValueChange={(v) => setRisk(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={3} title="Notes">
          <WorkflowField label="Context">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </WorkflowField>
        </WorkflowSheetSection>
      </TalentFormShell>
    </>
  );
}

function AddSuccessorDialog({ planId, employees, onAdd }: { planId: string; employees: any[]; onAdd: (args: any) => Promise<any> }) {
  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const [readiness, setReadiness] = useState<SuccessorReadiness>("ready_1_2y");
  const [rank, setRank] = useState(1);
  const [notes, setNotes] = useState("");
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}><UserPlus className="h-4 w-4 mr-1" /> Add successor</Button>
      <TalentFormShell
        open={open}
        onOpenChange={setOpen}
        entity="successor"
        mode="create"
        submitDisabled={!employeeId}
        submitLabel="Add successor"
        onSubmit={async () => {
          await onAdd({ plan_id: planId, employee_id: employeeId, readiness, rank, development_notes: notes || undefined });
          setOpen(false); setEmployeeId(""); setNotes(""); setReadiness("ready_1_2y"); setRank(1);
        }}
      >
        <WorkflowSheetSection number={1} title="Candidate">
          <WorkflowField label="Employee" required>
            <Select value={employeeId} onValueChange={setEmployeeId}>
              <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
              <SelectContent>
                {employees.map((e) => <SelectItem key={e.id} value={e.id}>{e.first_name} {e.last_name}</SelectItem>)}
              </SelectContent>
            </Select>
          </WorkflowField>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={2} title="Readiness">
          <WorkflowSheetGrid>
            <WorkflowField label="Readiness">
              <Select value={readiness} onValueChange={(v) => setReadiness(v as SuccessorReadiness)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(READINESS_LABEL).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
            </WorkflowField>
            <WorkflowField label="Rank">
              <Input type="number" min={1} value={rank} onChange={(e) => setRank(parseInt(e.target.value) || 1)} />
            </WorkflowField>
          </WorkflowSheetGrid>
          <WorkflowField label="Development notes">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </WorkflowField>
        </WorkflowSheetSection>
      </TalentFormShell>
    </>
  );
}

// ---------------------------------------------------------------------- Pools
function TalentPoolsTab() {
  const { pools, members, createPool, deletePool, addMember, removeMember } = useTalentPools();
  const { employees } = useEmployees();
  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const membersByPool = useMemo(() => {
    const m = new Map<string, typeof members>();
    for (const x of members) {
      if (!m.has(x.pool_id)) m.set(x.pool_id, []);
      m.get(x.pool_id)!.push(x);
    }
    return m;
  }, [members]);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <NewPoolDialog onCreate={(args) => createPool.mutateAsync(args)} />
      </div>
      <div className="grid gap-3">
        {pools.length === 0 ? (
          <Card><CardContent className="p-6 text-sm text-muted-foreground">No talent pools yet. Create one for High Potentials, Retention Risks, or Leadership bench.</CardContent></Card>
        ) : pools.map((pool) => {
          const items = membersByPool.get(pool.id) ?? [];
          return (
            <Card key={pool.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    {pool.name}
                    <Badge variant="secondary">{POOL_TYPE_LABEL[pool.pool_type]}</Badge>
                    <Badge variant="outline">{items.length} member{items.length === 1 ? "" : "s"}</Badge>
                  </CardTitle>
                  {pool.description ? <CardDescription>{pool.description}</CardDescription> : null}
                </div>
                <div className="flex gap-2">
                  <AddPoolMemberDialog poolId={pool.id} employees={employees} onAdd={(args) => addMember.mutateAsync(args)} />
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => deletePool.mutateAsync(pool.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {items.length === 0 ? <p className="text-sm text-muted-foreground">No members.</p>
                  : items.map((m) => {
                    const e = empById.get(m.employee_id);
                    return (
                      <Badge key={m.id} variant="outline" className="gap-1.5 py-1">
                        {e ? `${e.first_name} ${e.last_name}` : "Unknown"}
                        {m.readiness ? <span className="text-[10px] text-muted-foreground">· {m.readiness.replace(/_/g, " ")}</span> : null}
                        <button onClick={() => removeMember.mutate(m.id)} className="ml-1 hover:text-destructive"><Trash2 className="h-3 w-3" /></button>
                      </Badge>
                    );
                  })}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function NewPoolDialog({ onCreate }: { onCreate: (args: any) => Promise<any> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<PoolType>("high_potential");
  const [desc, setDesc] = useState("");
  return (
    <>
      <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1" /> New pool</Button>
      <TalentFormShell
        open={open}
        onOpenChange={setOpen}
        entity="talent-pool"
        mode="create"
        submitDisabled={!name.trim()}
        submitLabel="Create pool"
        onSubmit={async () => {
          await onCreate({ name: name.trim(), pool_type: type, description: desc || undefined });
          setOpen(false); setName(""); setDesc(""); setType("high_potential");
        }}
      >
        <WorkflowSheetSection number={1} title="Identity">
          <WorkflowSheetGrid>
            <WorkflowField label="Name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 2026 High Potentials" />
            </WorkflowField>
            <WorkflowField label="Type">
              <Select value={type} onValueChange={(v) => setType(v as PoolType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(POOL_TYPE_LABEL).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
            </WorkflowField>
          </WorkflowSheetGrid>
          <WorkflowField label="Description">
            <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} />
          </WorkflowField>
        </WorkflowSheetSection>
      </TalentFormShell>
    </>
  );
}

function AddPoolMemberDialog({ poolId, employees, onAdd }: { poolId: string; employees: any[]; onAdd: (args: any) => Promise<any> }) {
  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const [readiness, setReadiness] = useState<ReadinessTag | "">("");
  const [notes, setNotes] = useState("");
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}><UserPlus className="h-4 w-4 mr-1" /> Add member</Button>
      <TalentFormShell
        open={open}
        onOpenChange={setOpen}
        entity="talent-pool-member"
        mode="create"
        submitDisabled={!employeeId}
        submitLabel="Add to pool"
        onSubmit={async () => {
          await onAdd({ pool_id: poolId, employee_id: employeeId, readiness: readiness || undefined, notes: notes || undefined });
          setOpen(false); setEmployeeId(""); setNotes(""); setReadiness("");
        }}
      >
        <WorkflowSheetSection number={1} title="Member">
          <WorkflowSheetGrid>
            <WorkflowField label="Employee" required>
              <Select value={employeeId} onValueChange={setEmployeeId}>
                <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {employees.map((e) => <SelectItem key={e.id} value={e.id}>{e.first_name} {e.last_name}</SelectItem>)}
                </SelectContent>
              </Select>
            </WorkflowField>
            <WorkflowField label="Readiness (optional)">
              <Select value={readiness} onValueChange={(v) => setReadiness(v as ReadinessTag)}>
                <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ready_now">Ready now</SelectItem>
                  <SelectItem value="ready_1_2y">Ready 1–2y</SelectItem>
                  <SelectItem value="ready_3_5y">Ready 3–5y</SelectItem>
                  <SelectItem value="development_needed">Development needed</SelectItem>
                </SelectContent>
              </Select>
            </WorkflowField>
          </WorkflowSheetGrid>
          <WorkflowField label="Notes">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </WorkflowField>
        </WorkflowSheetSection>
      </TalentFormShell>
    </>
  );
}

// ----------------------------------------------------------------------- Util
function Kpi({ label, value, tone }: { label: string; value: number | string; tone?: "emerald" | "destructive" }) {
  const cls = tone === "emerald" ? "text-emerald-600" : tone === "destructive" ? "text-destructive" : "";
  return (
    <Card><CardContent className="pt-6">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-semibold ${cls}`}>{value}</p>
    </CardContent></Card>
  );
}
