/**
 * Competencies — HR/Manager Phase 3 framework.
 *
 * Tabs:
 *   - Catalog: competency list + create
 *   - Scale: define proficiency scale (1..N with labels)
 *   - Role profiles: for each job position, set required level per competency
 *   - Gap heat-map: matrix of employees × competencies showing
 *     final_level − required_level
 */
import { useMemo, useState } from "react";
import { useCompetencies, useCompetencyScales, useRoleRequirements, useCompetencyAssessments, requiredLevelFor, DEFAULT_SCALE, type ScaleLevel } from "@/hooks/useCompetencyFramework";
import { useEmployees } from "@/hooks/useEmployees";
import { useJobPositions } from "@/hooks/useJobPositions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Briefcase, Plus, Trash2 } from "lucide-react";
import { TalentFormShell } from "@/components/talent/_shared/TalentFormShell";
import { WorkflowSheetGrid, WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";

export default function CompetenciesPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><Briefcase className="h-5 w-5" /> Competencies</h1>
        <p className="text-sm text-muted-foreground">Define the skills your organisation values, the proficiency scale, role requirements, and see where the gaps are.</p>
      </div>

      <Tabs defaultValue="catalog">
        <TabsList>
          <TabsTrigger value="catalog">Catalog</TabsTrigger>
          <TabsTrigger value="scale">Scale</TabsTrigger>
          <TabsTrigger value="roles">Role profiles</TabsTrigger>
          <TabsTrigger value="gaps">Gap heat-map</TabsTrigger>
        </TabsList>

        <TabsContent value="catalog"><CatalogTab /></TabsContent>
        <TabsContent value="scale"><ScaleTab /></TabsContent>
        <TabsContent value="roles"><RoleProfilesTab /></TabsContent>
        <TabsContent value="gaps"><GapHeatmapTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------
function CatalogTab() {
  const { competencies, isLoading, createCompetency } = useCompetencies();
  const { defaultScale } = useCompetencyScales();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", category: "", is_core: false });

  async function submit() {
    await createCompetency.mutateAsync({
      name: form.name,
      description: form.description || undefined,
      category: form.category || undefined,
      is_core: form.is_core,
      scale_id: defaultScale?.id ?? null,
    });
    setOpen(false);
    setForm({ name: "", description: "", category: "", is_core: false });
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1" /> New competency</Button>
        <TalentFormShell
          open={open}
          onOpenChange={setOpen}
          entity="competency"
          mode="create"
          busy={createCompetency.isPending}
          submitDisabled={!form.name}
          onSubmit={submit}
        >
          <WorkflowSheetSection number={1} title="Identity" subtitle="What this competency is called and how it's grouped in the catalog.">
            <WorkflowSheetGrid>
              <WorkflowField label="Name" required>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </WorkflowField>
              <WorkflowField label="Category" hint="e.g. Technical, Behavioural, Leadership.">
                <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Technical / Behavioural / Leadership" />
              </WorkflowField>
            </WorkflowSheetGrid>
            <WorkflowField label="Description" hint="Plain language describing the behaviour we want to see.">
              <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />
            </WorkflowField>
          </WorkflowSheetSection>

          <WorkflowSheetSection number={2} title="Scope" subtitle="Core competencies apply to every employee — others are opt-in per role.">
            <label className="flex items-start gap-3 rounded-md border p-3 text-sm cursor-pointer">
              <Checkbox checked={form.is_core} onCheckedChange={(v) => setForm({ ...form, is_core: !!v })} />
              <span>
                <span className="font-medium">Core competency</span>
                <span className="block text-xs text-muted-foreground">Applies org-wide. Used as a default requirement on every role profile.</span>
              </span>
            </label>
          </WorkflowSheetSection>
        </TalentFormShell>
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> :
       competencies.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No competencies yet. Add a few that matter to your business.</CardContent></Card>
      ) : (
        <div className="grid md:grid-cols-2 gap-2">
          {competencies.map((c) => (
            <Card key={c.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <CardTitle className="text-base">{c.name}</CardTitle>
                  <div className="flex gap-1">
                    {c.is_core ? <Badge>core</Badge> : null}
                    {c.category ? <Badge variant="outline">{c.category}</Badge> : null}
                  </div>
                </div>
                {c.description ? <CardDescription>{c.description}</CardDescription> : null}
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
function ScaleTab() {
  const { scales, defaultScale, upsertScale } = useCompetencyScales();
  const seed = defaultScale ?? { id: undefined as any, name: "Default scale", levels: DEFAULT_SCALE, is_default: true };
  const [name, setName] = useState(seed.name);
  const [levels, setLevels] = useState<ScaleLevel[]>(seed.levels);

  function updateLevel(idx: number, patch: Partial<ScaleLevel>) {
    setLevels((cur) => cur.map((l, i) => i === idx ? { ...l, ...patch } : l));
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Proficiency scale</CardTitle>
          <CardDescription>The shared vocabulary used by every assessment and role profile.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div><Label>Scale name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-2">
            {levels.map((l, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center">
                <div className="col-span-1 text-sm font-semibold text-center">{l.level}</div>
                <Input className="col-span-3" value={l.label} onChange={(e) => updateLevel(i, { label: e.target.value })} />
                <Input className="col-span-8" placeholder="Description (what good looks like)" value={l.description ?? ""} onChange={(e) => updateLevel(i, { description: e.target.value })} />
              </div>
            ))}
          </div>
          <Button onClick={() => upsertScale.mutate({ id: defaultScale?.id, name, levels, is_default: true })} disabled={upsertScale.isPending}>Save scale</Button>
          {scales.length === 0 ? <p className="text-xs text-muted-foreground">Saving will create your organisation's default scale.</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------
function RoleProfilesTab() {
  const { competencies } = useCompetencies();
  const { requirements, upsertRequirement, removeRequirement } = useRoleRequirements();
  const { positions: jobPositions } = useJobPositions();
  const { defaultScale } = useCompetencyScales();
  const [jobId, setJobId] = useState<string>("");

  const max = defaultScale?.levels.length ?? 5;
  const positionReqs = useMemo(
    () => requirements.filter((r) => r.job_position_id === jobId),
    [requirements, jobId],
  );
  const reqMap = new Map(positionReqs.map((r) => [r.competency_id, r] as const));

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Role requirements</CardTitle>
          <CardDescription>For each job position, set the required proficiency level per competency. Used to compute employee gaps.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="max-w-sm">
            <Label>Job position</Label>
            <Select value={jobId} onValueChange={setJobId}>
              <SelectTrigger><SelectValue placeholder="Pick a job position" /></SelectTrigger>
              <SelectContent>
                {(jobPositions ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name ?? p.title}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {!jobId ? <p className="text-sm text-muted-foreground">Pick a job position to define its profile.</p> : (
            <div className="space-y-2">
              {competencies.length === 0 ? <p className="text-sm text-muted-foreground">Add competencies first.</p> : competencies.map((c) => {
                const req = reqMap.get(c.id);
                return (
                  <div key={c.id} className="flex items-center gap-2 rounded border px-3 py-2">
                    <span className="flex-1 text-sm">{c.name}</span>
                    <Select
                      value={req ? String(req.required_level) : ""}
                      onValueChange={(v) => upsertRequirement.mutate({ competency_id: c.id, job_position_id: jobId, required_level: Number(v) })}
                    >
                      <SelectTrigger className="h-8 w-32 text-xs"><SelectValue placeholder="Not required" /></SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: max }).map((_, i) => <SelectItem key={i + 1} value={String(i + 1)}>Level {i + 1}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {req ? <Button size="sm" variant="ghost" onClick={() => removeRequirement.mutate(req.id)}><Trash2 className="h-3 w-3" /></Button> : null}
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

// ---------------------------------------------------------------------
function GapHeatmapTab() {
  const { employees } = useEmployees();
  const { competencies } = useCompetencies();
  const { requirements } = useRoleRequirements();
  const { assessments } = useCompetencyAssessments();

  const empById = new Map(((employees ?? []) as any[]).map((e) => [e.id, e]));
  const sample = (employees ?? []).slice(0, 25);

  function gapFor(employeeId: string, competencyId: string): { level: number | null; required: number | null; gap: number | null } {
    const a = assessments.find((x) => x.employee_id === employeeId && x.competency_id === competencyId);
    const level = a?.final_level ?? null;
    const emp = empById.get(employeeId);
    const required = requiredLevelFor(requirements, competencyId, emp?.job_position_id, emp?.department_id);
    return { level, required, gap: level != null && required != null ? level - required : null };
  }

  function cellTone(gap: number | null): string {
    if (gap == null) return "bg-muted/40 text-muted-foreground";
    if (gap >= 1) return "bg-success/15 text-success";
    if (gap === 0) return "bg-primary/15 text-foreground";
    if (gap === -1) return "bg-warning/15 text-warning";
    return "bg-destructive/15 text-destructive";
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Gap heat-map</CardTitle>
        <CardDescription>Employee proficiency minus required level. Red = critical gap, green = surplus. Showing up to 25 employees.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-auto">
        {competencies.length === 0 || sample.length === 0 ? (
          <p className="text-sm text-muted-foreground">Need at least one competency and one employee to render.</p>
        ) : (
          <table className="text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 bg-background px-2 py-1 text-left">Employee</th>
                {competencies.slice(0, 12).map((c) => (
                  <th key={c.id} className="px-2 py-1 text-left whitespace-nowrap" title={c.name}>{c.name.slice(0, 14)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sample.map((e: any) => (
                <tr key={e.id} className="border-t">
                  <td className="sticky left-0 bg-background px-2 py-1 whitespace-nowrap">{e.first_name} {e.last_name}</td>
                  {competencies.slice(0, 12).map((c) => {
                    const { level, required, gap } = gapFor(e.id, c.id);
                    return (
                      <td key={c.id} className={"px-2 py-1 text-center " + cellTone(gap)}>
                        {level ?? "—"}{required != null ? `/${required}` : ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
