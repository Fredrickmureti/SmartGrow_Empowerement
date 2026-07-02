/**
 * QuizAuthorPage — Phase G. Authoring surface for course quizzes.
 *
 * Mounted at /hr/talent/quizzes. HR/Talent admin selects a course, manages
 * its quizzes (pass score, attempt limits), and edits questions (single/
 * multi choice, true/false, short text) with correct answers and points.
 */
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/hooks/useOrganization";
import { useQuizzes, useQuizQuestions, TrainingQuiz, QuizQuestion } from "@/hooks/useLearningPaths";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TalentFormShell } from "@/components/talent/_shared/TalentFormShell";
import { WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { Checkbox } from "@/components/ui/checkbox";
import { FileQuestion, Plus, Trash2 } from "lucide-react";

const sb = supabase as any;

export default function QuizAuthorPage() {
  const { currentOrg } = useOrganization();
  const [courseId, setCourseId] = useState<string>("");
  const [quizId, setQuizId] = useState<string>("");

  const { data: courses = [] } = useQuery({
    queryKey: ["courses-for-quiz", currentOrg?.id],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      const { data, error } = await sb
        .from("training_courses")
        .select("id, name")
        .eq("organization_id", currentOrg!.id)
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { quizzes, create } = useQuizzes(courseId || undefined);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2"><FileQuestion className="h-5 w-5" /> Quiz authoring</CardTitle>
            <CardDescription>Build quizzes that grade automatically and award competency on pass.</CardDescription>
          </div>
          <Select value={courseId} onValueChange={(v) => { setCourseId(v); setQuizId(""); }}>
            <SelectTrigger className="w-[320px]"><SelectValue placeholder="Pick course" /></SelectTrigger>
            <SelectContent>
              {(courses as any[]).map(c => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!courseId && <div className="text-sm text-muted-foreground">Select a course to author quizzes.</div>}

        {courseId && (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              {quizzes.map(q => (
                <Button key={q.id} variant={quizId === q.id ? "default" : "outline"} size="sm" onClick={() => setQuizId(q.id)}>
                  {q.title} <Badge variant="secondary" className="ml-2">pass {q.pass_score}%</Badge>
                </Button>
              ))}
              <NewQuizDialog onCreate={(input) => create.mutate(input)} />
            </div>

            {quizId && <QuestionsEditor quizId={quizId} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function NewQuizDialog({ onCreate }: { onCreate: (input: Partial<TrainingQuiz>) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Partial<TrainingQuiz>>({ title: "", pass_score: 70, max_attempts: 3 });
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1" /> Quiz</Button>
      <TalentFormShell
        open={open}
        onOpenChange={setOpen}
        entity="quiz"
        mode="create"
        submitDisabled={!form.title}
        submitLabel="Create quiz"
        onSubmit={() => {
          if (!form.title) return;
          onCreate(form);
          setOpen(false);
          setForm({ title: "", pass_score: 70, max_attempts: 3 });
        }}
      >
        <WorkflowSheetSection number={1} title="Identity">
          <WorkflowField label="Title" required>
            <Input value={form.title ?? ""} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Module 1 — Foundations" />
          </WorkflowField>
          <WorkflowField label="Description">
            <Textarea value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} />
          </WorkflowField>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={2} title="Scoring & attempts">
          <WorkflowSheetGrid columns={3}>
            <WorkflowField label="Pass %">
              <Input type="number" value={form.pass_score ?? 70} onChange={(e) => setForm({ ...form, pass_score: Number(e.target.value) })} />
            </WorkflowField>
            <WorkflowField label="Time limit (min)">
              <Input type="number" value={form.time_limit_minutes ?? ""} onChange={(e) => setForm({ ...form, time_limit_minutes: e.target.value ? Number(e.target.value) : null })} />
            </WorkflowField>
            <WorkflowField label="Max attempts">
              <Input type="number" value={form.max_attempts ?? 3} onChange={(e) => setForm({ ...form, max_attempts: Number(e.target.value) })} />
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
      </TalentFormShell>
    </>
  );
}

function QuestionsEditor({ quizId }: { quizId: string }) {
  const { questions, addQuestion, removeQuestion } = useQuizQuestions(quizId);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Partial<QuizQuestion>>({
    question_type: "single_choice", options: ["", "", "", ""], correct_answers: [], points: 1, prompt: "",
  });

  const reset = () => setDraft({
    question_type: "single_choice", options: ["", "", "", ""], correct_answers: [], points: 1, prompt: "",
  });

  const submit = async () => {
    if (!draft.prompt) return;
    let correct = draft.correct_answers ?? [];
    if (draft.question_type === "true_false") {
      draft.options = ["true", "false"];
    }
    await addQuestion.mutateAsync({ ...draft, correct_answers: correct, sequence_no: (questions.length ?? 0) + 1 });
    setOpen(false);
    reset();
  };

  const opts = (draft.options as string[]) ?? [];

  const toggleCorrect = (val: string) => {
    const cur = (draft.correct_answers as string[]) ?? [];
    if (draft.question_type === "multi_choice") {
      setDraft({ ...draft, correct_answers: cur.includes(val) ? cur.filter(x => x !== val) : [...cur, val] });
    } else {
      setDraft({ ...draft, correct_answers: [val] });
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-medium">Questions ({questions.length})</div>
        <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1" /> Question</Button>
        <TalentFormShell
          open={open}
          onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}
          entity="quiz-question"
          mode="create"
          submitDisabled={!draft.prompt}
          submitLabel="Add question"
          onSubmit={submit}
        >
          <WorkflowSheetSection number={1} title="Question">
            <WorkflowField label="Type">
              <Select value={draft.question_type} onValueChange={(v: any) => setDraft({
                ...draft, question_type: v,
                options: v === "true_false" ? ["true", "false"] : v === "short_text" ? [] : ["", "", "", ""],
                correct_answers: [],
              })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="single_choice">Single choice</SelectItem>
                  <SelectItem value="multi_choice">Multi choice</SelectItem>
                  <SelectItem value="true_false">True / false</SelectItem>
                  <SelectItem value="short_text">Short text</SelectItem>
                </SelectContent>
              </Select>
            </WorkflowField>
            <WorkflowField label="Prompt" required>
              <Textarea value={draft.prompt ?? ""} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} rows={3} />
            </WorkflowField>
          </WorkflowSheetSection>

          <WorkflowSheetSection number={2} title="Answer">
            {(draft.question_type === "single_choice" || draft.question_type === "multi_choice") && (
              <div className="space-y-2">
                <Label className="text-xs">Options (check correct)</Label>
                {opts.map((o, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Checkbox checked={(draft.correct_answers as string[])?.includes(o)} onCheckedChange={() => toggleCorrect(o)} disabled={!o} />
                    <Input value={o} onChange={(e) => {
                      const next = [...opts]; next[i] = e.target.value;
                      const correctNow = (draft.correct_answers as string[]).map(c => c === o ? e.target.value : c);
                      setDraft({ ...draft, options: next, correct_answers: correctNow });
                    }} placeholder={`Option ${i + 1}`} />
                  </div>
                ))}
                <Button size="sm" variant="ghost" type="button" onClick={() => setDraft({ ...draft, options: [...opts, ""] })}>
                  <Plus className="h-3 w-3 mr-1" /> add option
                </Button>
              </div>
            )}

            {draft.question_type === "true_false" && (
              <div className="flex gap-3">
                {["true", "false"].map(v => (
                  <label key={v} className="flex items-center gap-2">
                    <input type="radio" checked={(draft.correct_answers as string[])?.[0] === v} onChange={() => setDraft({ ...draft, correct_answers: [v] })} />
                    {v}
                  </label>
                ))}
              </div>
            )}

            {draft.question_type === "short_text" && (
              <Input placeholder="Correct answer (case-insensitive)"
                value={(draft.correct_answers as string[])?.[0] ?? ""}
                onChange={(e) => setDraft({ ...draft, correct_answers: [e.target.value] })} />
            )}
          </WorkflowSheetSection>

          <WorkflowSheetSection number={3} title="Scoring">
            <WorkflowSheetGrid>
              <WorkflowField label="Points">
                <Input type="number" value={draft.points ?? 1} onChange={(e) => setDraft({ ...draft, points: Number(e.target.value) })} />
              </WorkflowField>
              <WorkflowField label="Explanation (optional)" hint="Shown after a learner answers.">
                <Input value={draft.explanation ?? ""} onChange={(e) => setDraft({ ...draft, explanation: e.target.value })} />
              </WorkflowField>
            </WorkflowSheetGrid>
          </WorkflowSheetSection>
        </TalentFormShell>
      </div>

      <div className="space-y-2">
        {questions.map((q, idx) => (
          <div key={q.id} className="border rounded p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm">
                  <span className="text-muted-foreground mr-2">#{idx + 1}</span>
                  <Badge variant="outline" className="mr-2">{q.question_type}</Badge>
                  <Badge variant="secondary">{q.points} pt</Badge>
                </div>
                <div className="font-medium mt-1">{q.prompt}</div>
                {Array.isArray(q.options) && q.options.length > 0 && (
                  <ul className="text-xs text-muted-foreground mt-1 space-y-0.5">
                    {(q.options as string[]).map((o, i) => (
                      <li key={i} className={(q.correct_answers as string[])?.includes(o) ? "text-foreground font-medium" : ""}>
                        {(q.correct_answers as string[])?.includes(o) ? "✓ " : "• "}{o}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <Button size="icon" variant="ghost" onClick={() => removeQuestion.mutate(q.id)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
        {!questions.length && <div className="text-sm text-muted-foreground">No questions yet.</div>}
      </div>
    </div>
  );
}
