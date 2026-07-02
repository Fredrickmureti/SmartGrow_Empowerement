/**
 * MyQuizPlayerPage — Phase G. Employee takes a quiz tied to a course.
 *
 * URL: /me/learning/quiz/:quizId. Starts a new attempt, presents questions
 * one screen, and submits via `talent_quiz_grade` — which writes the score,
 * marks the course enrollment complete on pass, and upserts the course's
 * tagged competencies at the target proficiency.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/hooks/useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { useQuizAttemptActions, QuizAttempt } from "@/hooks/useLearningPaths";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { FileQuestion, CheckCircle2, XCircle } from "lucide-react";

const sb = supabase as any;

export default function MyQuizPlayerPage() {
  const { quizId } = useParams();
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { user } = useAuth();
  const { start, grade } = useQuizAttemptActions();
  const [attempt, setAttempt] = useState<QuizAttempt | null>(null);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [result, setResult] = useState<QuizAttempt | null>(null);

  const { data: meEmp } = useQuery({
    queryKey: ["me-employee-id", currentOrg?.id, user?.id],
    enabled: !!currentOrg?.id && !!user?.id,
    queryFn: async () => {
      const { data } = await sb.from("v_employees_canonical").select("id").eq("organization_id", currentOrg!.id).eq("user_id", user!.id).maybeSingle();
      return data?.id as string | undefined;
    },
  });

  const { data: quiz } = useQuery({
    queryKey: ["quiz", quizId],
    enabled: !!quizId,
    queryFn: async () => {
      const { data } = await sb.from("training_quizzes").select("*, training_courses(id,name,target_level)").eq("id", quizId).maybeSingle();
      return data;
    },
  });

  const { data: questions = [] } = useQuery({
    queryKey: ["quiz-questions", quizId],
    enabled: !!quizId,
    queryFn: async () => {
      const { data } = await sb.from("quiz_questions").select("id, prompt, question_type, options, points, sequence_no").eq("quiz_id", quizId).order("sequence_no");
      return data ?? [];
    },
  });

  const { data: existingEnrollment } = useQuery({
    queryKey: ["course-enrollment", meEmp, quiz?.course_id],
    enabled: !!meEmp && !!quiz?.course_id,
    queryFn: async () => {
      const { data } = await sb.from("training_enrollments").select("id").eq("employee_id", meEmp).eq("course_id", quiz!.course_id).maybeSingle();
      return data?.id as string | undefined;
    },
  });

  const beginAttempt = async () => {
    if (!meEmp || !quizId) return;
    const a = await start.mutateAsync({ quiz_id: quizId, employee_id: meEmp, enrollment_id: existingEnrollment ?? null });
    setAttempt(a);
  };

  const submit = async () => {
    if (!attempt) return;
    const res = await grade.mutateAsync({ attempt_id: attempt.id, answers });
    setResult(res);
  };

  const answeredCount = useMemo(() => Object.keys(answers).filter(k => {
    const v = answers[k];
    return v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);
  }).length, [answers]);

  if (!quiz) return <div className="p-6 text-sm text-muted-foreground">Loading quiz…</div>;

  if (result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {result.passed ? <CheckCircle2 className="h-5 w-5 text-green-600" /> : <XCircle className="h-5 w-5 text-destructive" />}
            {result.passed ? "Passed" : "Not yet"}
          </CardTitle>
          <CardDescription>Score: {result.score}% (pass {quiz.pass_score}%)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {result.passed && quiz.training_courses?.target_level && (
            <div className="text-sm text-muted-foreground">Your competency was updated to level {quiz.training_courses.target_level}.</div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate("/me/learning")}>Back to learning</Button>
            {!result.passed && (
              <Button onClick={() => { setResult(null); setAttempt(null); setAnswers({}); }}>Try again</Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!attempt) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileQuestion className="h-5 w-5" /> {quiz.title}</CardTitle>
          <CardDescription>
            {quiz.description ?? `Course: ${quiz.training_courses?.name}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm flex gap-3 flex-wrap">
            <Badge variant="outline">Pass {quiz.pass_score}%</Badge>
            <Badge variant="outline">{questions.length} questions</Badge>
            {quiz.time_limit_minutes && <Badge variant="outline">{quiz.time_limit_minutes} min</Badge>}
            <Badge variant="outline">Max attempts {quiz.max_attempts}</Badge>
          </div>
          <Button onClick={beginAttempt} disabled={!meEmp || !questions.length}>Start attempt</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{quiz.title}</CardTitle>
        <CardDescription>
          <Progress value={questions.length ? (answeredCount / questions.length) * 100 : 0} className="h-2 mt-2" />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {(questions as any[]).map((q, i) => (
          <div key={q.id} className="space-y-2">
            <div className="font-medium">
              <span className="text-muted-foreground mr-2">{i + 1}.</span>{q.prompt}
              <Badge variant="secondary" className="ml-2">{q.points} pt</Badge>
            </div>
            {q.question_type === "single_choice" && (
              <div className="space-y-1.5">
                {(q.options as string[]).map(o => (
                  <label key={o} className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name={q.id} checked={answers[q.id] === o}
                      onChange={() => setAnswers({ ...answers, [q.id]: o })} />
                    {o}
                  </label>
                ))}
              </div>
            )}
            {q.question_type === "multi_choice" && (
              <div className="space-y-1.5">
                {(q.options as string[]).map(o => {
                  const cur: string[] = answers[q.id] ?? [];
                  return (
                    <label key={o} className="flex items-center gap-2 cursor-pointer">
                      <Checkbox checked={cur.includes(o)} onCheckedChange={() =>
                        setAnswers({ ...answers, [q.id]: cur.includes(o) ? cur.filter(x => x !== o) : [...cur, o] })} />
                      {o}
                    </label>
                  );
                })}
              </div>
            )}
            {q.question_type === "true_false" && (
              <div className="flex gap-3">
                {["true", "false"].map(v => (
                  <label key={v} className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name={q.id} checked={answers[q.id] === v}
                      onChange={() => setAnswers({ ...answers, [q.id]: v })} />
                    {v}
                  </label>
                ))}
              </div>
            )}
            {q.question_type === "short_text" && (
              <Input value={answers[q.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
            )}
          </div>
        ))}
        <div className="flex items-center justify-between pt-2 border-t">
          <div className="text-xs text-muted-foreground">{answeredCount} of {questions.length} answered</div>
          <Button onClick={submit} disabled={grade.isPending}>Submit</Button>
        </div>
      </CardContent>
    </Card>
  );
}
