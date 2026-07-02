/**
 * Reviews — HR/Manager view of all performance reviews in flight, with a
 * cycle launch wizard that creates per-participant review assignments
 * from a template.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTalentCycles } from "@/hooks/useTalent";
import { useReviewTemplates, useReviews, type ReviewStatus } from "@/hooks/useReviews";
import { useEmployees } from "@/hooks/useEmployees";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge as _Badge } from "@/components/ui/badge";
import { TalentFormShell } from "@/components/talent/_shared/TalentFormShell";
import { WorkflowSheetGrid, WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { ClipboardList, Rocket, ChevronRight, FileText } from "lucide-react";

const STATUS_VARIANT: Record<ReviewStatus, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "outline",
  in_progress: "secondary",
  submitted: "default",
  calibrated: "secondary",
  signed_off: "default",
  acknowledged: "default",
  cancelled: "destructive",
};

export default function ReviewsPage() {
  const { cycles } = useTalentCycles();
  const { templates } = useReviewTemplates();
  const [cycleFilter, setCycleFilter] = useState<string | undefined>(undefined);
  const { reviews, isLoading, launchReviews } = useReviews({ cycleId: cycleFilter });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><ClipboardList className="h-5 w-5" /> Performance reviews</h1>
          <p className="text-sm text-muted-foreground">Track all review assignments — self, manager, peer — through to sign-off and acknowledgement.</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline"><Link to="/hr/talent/review-templates"><FileText className="h-4 w-4 mr-1" /> Templates</Link></Button>
          <LaunchDialog
            cycles={cycles}
            templates={templates}
            onLaunch={(args) => launchReviews.mutateAsync(args)}
            disabled={launchReviews.isPending}
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Label className="text-xs">Cycle</Label>
        <Select value={cycleFilter ?? "__all"} onValueChange={(v) => setCycleFilter(v === "__all" ? undefined : v)}>
          <SelectTrigger className="h-8 w-64 text-xs"><SelectValue placeholder="All cycles" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">All cycles</SelectItem>
            {cycles.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> :
        reviews.length === 0 ? (
          <Card><CardContent className="py-10 text-center">
            <p className="text-sm text-muted-foreground">No reviews yet. Use “Launch reviews” to assign a template to a cycle's participants.</p>
          </CardContent></Card>
        ) : (
          <div className="grid gap-2">
            {reviews.map((r) => (
              <Link key={r.id} to={`/hr/talent/reviews/${r.id}`} className="flex items-center gap-3 rounded-md border px-3 py-2 hover:bg-accent">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">
                    <Badge variant="outline" className="mr-2">{r.review_type}</Badge>
                    Employee {r.employee_id.slice(0, 8)}…
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.due_at ? `Due ${new Date(r.due_at).toLocaleDateString()}` : "No due date"}
                    {r.submitted_at ? ` · Submitted ${new Date(r.submitted_at).toLocaleDateString()}` : ""}
                  </p>
                </div>
                <Badge variant={STATUS_VARIANT[r.status] ?? "outline"}>{r.status.replace(/_/g, " ")}</Badge>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </Link>
            ))}
          </div>
        )}
    </div>
  );
}

function LaunchDialog({
  cycles, templates, onLaunch, disabled,
}: { cycles: any[]; templates: any[]; onLaunch: (a: { cycle_id: string; template_id: string; employee_ids: string[]; due_at?: string | null }) => Promise<any>; disabled: boolean }) {
  const { employees } = useEmployees();
  const [open, setOpen] = useState(false);
  const [cycleId, setCycleId] = useState<string>("");
  const [templateId, setTemplateId] = useState<string>("");
  const [dueAt, setDueAt] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const s = search.toLowerCase();
    return (employees ?? []).filter((e: any) =>
      `${e.first_name ?? ""} ${e.last_name ?? ""} ${e.email ?? ""}`.toLowerCase().includes(s),
    );
  }, [employees, search]);

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (!cycleId || !templateId || selected.size === 0) return;
    await onLaunch({ cycle_id: cycleId, template_id: templateId, employee_ids: Array.from(selected), due_at: dueAt || null });
    setOpen(false);
    setSelected(new Set());
  }

  return (
    <>
      <Button disabled={cycles.length === 0 || templates.length === 0} onClick={() => setOpen(true)}>
        <Rocket className="h-4 w-4 mr-1" /> Launch reviews
      </Button>
      <TalentFormShell
        open={open}
        onOpenChange={setOpen}
        entity="review"
        mode="create"
        title="Launch a review cycle"
        description="Pick the cycle, template, due date, and participants — one review per employee will be generated for each reviewer type the template requires."
        busy={disabled}
        submitDisabled={!cycleId || !templateId || selected.size === 0}
        submitLabel={<><Rocket className="h-4 w-4 mr-1" /> Launch</>}
        onSubmit={submit}
      >
        <WorkflowSheetSection number={1} title="Cycle & template" subtitle="The template defines the questionnaire; the cycle defines the period and phase deadlines.">
          <WorkflowSheetGrid>
            <WorkflowField label="Cycle" required>
              <Select value={cycleId} onValueChange={setCycleId}>
                <SelectTrigger><SelectValue placeholder="Pick a cycle" /></SelectTrigger>
                <SelectContent>{cycles.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
            </WorkflowField>
            <WorkflowField label="Template" required>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger><SelectValue placeholder="Pick a template" /></SelectTrigger>
                <SelectContent>{templates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
              </Select>
            </WorkflowField>
          </WorkflowSheetGrid>
          <WorkflowField label="Due date" hint="Optional — overrides the manager-review deadline from the cycle.">
            <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </WorkflowField>
        </WorkflowSheetSection>

        <WorkflowSheetSection
          number={2}
          title="Participants"
          subtitle="Pick everyone whose review should be created. Search filters the list; the buttons below act on whatever's visible."
          right={<_Badge variant="secondary">{selected.size} selected</_Badge>}
        >
          <Input placeholder="Search employees…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="max-h-72 overflow-auto rounded border divide-y">
            {filtered.slice(0, 200).map((e: any) => (
              <label key={e.id} className="flex items-center gap-2 px-2 py-1.5 text-sm cursor-pointer hover:bg-accent">
                <Checkbox checked={selected.has(e.id)} onCheckedChange={() => toggle(e.id)} />
                <span className="flex-1 truncate">{e.first_name} {e.last_name}</span>
                <span className="text-xs text-muted-foreground">{e.email}</span>
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" type="button" onClick={() => setSelected(new Set(filtered.map((e: any) => e.id)))}>Select all visible</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        </WorkflowSheetSection>
      </TalentFormShell>
    </>
  );
}
