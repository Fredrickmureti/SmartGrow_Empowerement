/**
 * Review Templates — HR designs reusable review forms (sections + questions
 * with per-audience visibility). Templates are then used by the cycle
 * launcher to generate the per-participant review assignments.
 */
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useReviewTemplates, useReviewTemplate, type ReviewRole } from "@/hooks/useReviews";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TalentFormShell } from "@/components/talent/_shared/TalentFormShell";
import { WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { Plus, Trash2, ArrowLeft, FileText } from "lucide-react";

const AUDIENCES: ReviewRole[] = ["self", "manager", "peer", "skip_level", "upward"];
const QTYPES = [
  { value: "rating_text", label: "Rating + comment" },
  { value: "rating", label: "Rating only" },
  { value: "text", label: "Comment only" },
  { value: "competency", label: "Competency rating" },
];

export default function ReviewTemplatesPage() {
  const { templateId } = useParams();
  if (templateId) return <TemplateBuilder templateId={templateId} />;
  return <TemplateList />;
}

function TemplateList() {
  const { templates, isLoading, createTemplate } = useReviewTemplates();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", self: true, manager: true, peer: false, skip: false });

  async function submit() {
    const id = await createTemplate.mutateAsync({
      name: form.name,
      description: form.description || undefined,
      includes_self: form.self,
      includes_manager: form.manager,
      includes_peer: form.peer,
      includes_skip_level: form.skip,
    });
    setOpen(false);
    setForm({ name: "", description: "", self: true, manager: true, peer: false, skip: false });
    window.location.href = `/hr/talent/review-templates/${id}`;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Review templates</h1>
          <p className="text-sm text-muted-foreground">Reusable review forms — used by the cycle launcher to generate review assignments.</p>
        </div>
        <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1" /> New template</Button>
        <TalentFormShell
          open={open}
          onOpenChange={setOpen}
          entity="review-template"
          mode="create"
          busy={createTemplate.isPending}
          submitDisabled={!form.name}
          submitLabel="Create & edit"
          onSubmit={submit}
        >
          <WorkflowSheetSection number={1} title="Identity">
            <WorkflowField label="Name" required>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Annual performance review" />
            </WorkflowField>
            <WorkflowField label="Description">
              <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} />
            </WorkflowField>
          </WorkflowSheetSection>
          <WorkflowSheetSection number={2} title="Audiences" subtitle="Which review types this template generates when launched.">
            <div className="space-y-2">
              {[
                ["self", "Self review", form.self, (v: boolean) => setForm({ ...form, self: v })],
                ["manager", "Manager review", form.manager, (v: boolean) => setForm({ ...form, manager: v })],
                ["peer", "Peer review", form.peer, (v: boolean) => setForm({ ...form, peer: v })],
                ["skip", "Skip-level review", form.skip, (v: boolean) => setForm({ ...form, skip: v })],
              ].map(([key, label, val, set]: any) => (
                <div key={key} className="flex items-center justify-between rounded border px-3 py-2">
                  <span className="text-sm">{label}</span>
                  <Switch checked={val} onCheckedChange={set} />
                </div>
              ))}
            </div>
          </WorkflowSheetSection>
        </TalentFormShell>
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> :
        templates.length === 0 ? (
          <Card><CardContent className="py-10 text-center">
            <FileText className="h-10 w-10 mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm text-muted-foreground mb-3">No templates yet — create one before launching reviews.</p>
            <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1" /> New template</Button>
          </CardContent></Card>
        ) : (
          <div className="grid gap-3">
            {templates.map((t) => (
              <Card key={t.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-base">{t.name}</CardTitle>
                      <CardDescription>{t.description ?? "No description"}</CardDescription>
                    </div>
                    <Button asChild variant="outline" size="sm"><Link to={`/hr/talent/review-templates/${t.id}`}>Edit</Link></Button>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-1">
                  {t.includes_self && <Badge variant="secondary">self</Badge>}
                  {t.includes_manager && <Badge variant="secondary">manager</Badge>}
                  {t.includes_peer && <Badge variant="secondary">peer</Badge>}
                  {t.includes_skip_level && <Badge variant="secondary">skip-level</Badge>}
                  {!t.is_active && <Badge variant="destructive">inactive</Badge>}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
    </div>
  );
}

function TemplateBuilder({ templateId }: { templateId: string }) {
  const { template, sections, questions, addSection, removeSection, addQuestion, removeQuestion } = useReviewTemplate(templateId);
  const [sectionTitle, setSectionTitle] = useState("");
  const [qForms, setQForms] = useState<Record<string, { prompt: string; type: string; audiences: string[] }>>({});

  if (!template) return <p className="text-sm text-muted-foreground">Loading…</p>;

  function setQForm(sectionId: string, patch: Partial<{ prompt: string; type: string; audiences: string[] }>) {
    setQForms((cur) => ({
      ...cur,
      [sectionId]: { prompt: "", type: "rating_text", audiences: ["self", "manager"], ...(cur[sectionId] ?? {}), ...patch },
    }));
  }

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm"><Link to="/hr/talent/review-templates"><ArrowLeft className="h-4 w-4 mr-1" /> All templates</Link></Button>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">{template.name}</CardTitle>
          <CardDescription>{template.description ?? "Add sections and questions below."}</CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Add section</CardTitle></CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input placeholder="Section title (e.g. Goals, Competencies, Behaviours)" value={sectionTitle} onChange={(e) => setSectionTitle(e.target.value)} />
            <Button
              disabled={!sectionTitle}
              onClick={async () => { await addSection.mutateAsync({ title: sectionTitle }); setSectionTitle(""); }}
            ><Plus className="h-4 w-4 mr-1" /> Add</Button>
          </div>
        </CardContent>
      </Card>

      {sections.map((s) => {
        const sq = questions.filter((q) => q.section_id === s.id);
        const f = qForms[s.id] ?? { prompt: "", type: "rating_text", audiences: ["self", "manager"] };
        return (
          <Card key={s.id}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{s.title}</CardTitle>
                <Button size="sm" variant="ghost" onClick={() => removeSection.mutate(s.id)}><Trash2 className="h-4 w-4" /></Button>
              </div>
              {s.description ? <CardDescription>{s.description}</CardDescription> : null}
            </CardHeader>
            <CardContent className="space-y-2">
              {sq.length === 0 ? <p className="text-xs text-muted-foreground">No questions yet.</p> : sq.map((q) => (
                <div key={q.id} className="flex items-start gap-2 rounded border px-3 py-2">
                  <div className="flex-1">
                    <p className="text-sm">{q.prompt}</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      <Badge variant="outline" className="text-[10px]">{q.question_type}</Badge>
                      {q.audiences.map((a) => <Badge key={a} variant="secondary" className="text-[10px]">{a}</Badge>)}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => removeQuestion.mutate(q.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              ))}
              <div className="rounded-md border-dashed border p-3 space-y-2">
                <Input placeholder="Question prompt…" value={f.prompt} onChange={(e) => setQForm(s.id, { prompt: e.target.value })} />
                <div className="grid grid-cols-2 gap-2">
                  <Select value={f.type} onValueChange={(v) => setQForm(s.id, { type: v })}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{QTYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
                  </Select>
                  <div className="flex flex-wrap gap-1">
                    {AUDIENCES.map((a) => {
                      const on = f.audiences.includes(a);
                      return (
                        <Badge
                          key={a}
                          variant={on ? "default" : "outline"}
                          className="cursor-pointer text-[10px]"
                          onClick={() => setQForm(s.id, { audiences: on ? f.audiences.filter((x) => x !== a) : [...f.audiences, a] })}
                        >{a}</Badge>
                      );
                    })}
                  </div>
                </div>
                <Button
                  size="sm"
                  disabled={!f.prompt || f.audiences.length === 0}
                  onClick={async () => {
                    await addQuestion.mutateAsync({ section_id: s.id, prompt: f.prompt, question_type: f.type, audiences: f.audiences });
                    setQForm(s.id, { prompt: "" });
                  }}
                ><Plus className="h-3 w-3 mr-1" /> Add question</Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
