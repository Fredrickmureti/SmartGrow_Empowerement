/**
 * useLearningPaths — Phase G learning paths, quizzes & attempts.
 */
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

const sb = supabase as any;

export interface LearningPath {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  target_role: string | null;
  category: string | null;
  cover_image_url: string | null;
  is_active: boolean;
  created_at: string;
}

export interface LearningPathCourse {
  id: string;
  path_id: string;
  course_id: string;
  sequence_no: number;
  is_required: boolean;
}

export interface LearningPathEnrollment {
  id: string;
  path_id: string;
  employee_id: string;
  status: "enrolled" | "in_progress" | "completed" | "dropped";
  started_at: string | null;
  completed_at: string | null;
}

export interface TrainingQuiz {
  id: string;
  course_id: string;
  title: string;
  description: string | null;
  pass_score: number;
  time_limit_minutes: number | null;
  max_attempts: number;
  is_active: boolean;
}

export interface QuizQuestion {
  id: string;
  quiz_id: string;
  prompt: string;
  question_type: "single_choice" | "multi_choice" | "true_false" | "short_text";
  options: any[];
  correct_answers: any[];
  points: number;
  sequence_no: number;
  explanation: string | null;
}

export interface QuizAttempt {
  id: string;
  quiz_id: string;
  employee_id: string;
  enrollment_id: string | null;
  attempt_no: number;
  started_at: string;
  submitted_at: string | null;
  answers: Record<string, any>;
  score: number | null;
  passed: boolean | null;
}

export function useLearningPaths() {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["learning-paths", currentOrg?.id],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      const { data, error } = await sb
        .from("learning_paths")
        .select("*")
        .eq("organization_id", currentOrg!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as LearningPath[];
    },
  });

  const create = useMutation({
    mutationFn: async (input: Partial<LearningPath>) => {
      const { data, error } = await sb
        .from("learning_paths")
        .insert({
          organization_id: currentOrg!.id,
          name: input.name,
          description: input.description,
          target_role: input.target_role,
          category: input.category,
          is_active: input.is_active ?? true,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Learning path created");
      qc.invalidateQueries({ queryKey: ["learning-paths"] });
    },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  const update = useMutation({
    mutationFn: async ({ id, ...patch }: Partial<LearningPath> & { id: string }) => {
      const { data, error } = await sb.from("learning_paths").update(patch).eq("id", id).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["learning-paths"] }),
    onError: (e) => toast.error(normalizeError(e).message),
  });

  return { paths: data ?? [], isLoading, create, update };
}

export function usePathCourses(pathId: string | undefined) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["learning-path-courses", pathId],
    enabled: !!pathId,
    queryFn: async () => {
      const { data, error } = await sb
        .from("learning_path_courses")
        .select("*, training_courses(id,name,duration_hours,delivery_mode)")
        .eq("path_id", pathId)
        .order("sequence_no");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { currentOrg } = useOrganization();

  const addCourse = useMutation({
    mutationFn: async (input: { course_id: string; sequence_no?: number; is_required?: boolean }) => {
      const { data, error } = await sb
        .from("learning_path_courses")
        .insert({
          organization_id: currentOrg!.id,
          path_id: pathId,
          course_id: input.course_id,
          sequence_no: input.sequence_no ?? 1,
          is_required: input.is_required ?? true,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["learning-path-courses", pathId] }),
    onError: (e) => toast.error(normalizeError(e).message),
  });

  const removeCourse = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await sb.from("learning_path_courses").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["learning-path-courses", pathId] }),
    onError: (e) => toast.error(normalizeError(e).message),
  });

  return { rows: data ?? [], isLoading, addCourse, removeCourse };
}

export function useQuizzes(courseId: string | undefined) {
  const qc = useQueryClient();
  const { currentOrg } = useOrganization();
  const { data, isLoading } = useQuery({
    queryKey: ["training-quizzes", courseId],
    enabled: !!courseId,
    queryFn: async () => {
      const { data, error } = await sb
        .from("training_quizzes")
        .select("*")
        .eq("course_id", courseId);
      if (error) throw error;
      return (data ?? []) as TrainingQuiz[];
    },
  });

  const create = useMutation({
    mutationFn: async (input: Partial<TrainingQuiz>) => {
      const { data, error } = await sb
        .from("training_quizzes")
        .insert({
          organization_id: currentOrg!.id,
          course_id: courseId,
          title: input.title,
          description: input.description,
          pass_score: input.pass_score ?? 70,
          time_limit_minutes: input.time_limit_minutes,
          max_attempts: input.max_attempts ?? 3,
          is_active: input.is_active ?? true,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Quiz created");
      qc.invalidateQueries({ queryKey: ["training-quizzes", courseId] });
    },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  return { quizzes: data ?? [], isLoading, create };
}

export function useQuizQuestions(quizId: string | undefined) {
  const qc = useQueryClient();
  const { currentOrg } = useOrganization();
  const { data, isLoading } = useQuery({
    queryKey: ["quiz-questions", quizId],
    enabled: !!quizId,
    queryFn: async () => {
      const { data, error } = await sb
        .from("quiz_questions")
        .select("*")
        .eq("quiz_id", quizId)
        .order("sequence_no");
      if (error) throw error;
      return (data ?? []) as QuizQuestion[];
    },
  });

  const addQuestion = useMutation({
    mutationFn: async (input: Partial<QuizQuestion>) => {
      const { data, error } = await sb
        .from("quiz_questions")
        .insert({
          organization_id: currentOrg!.id,
          quiz_id: quizId,
          prompt: input.prompt,
          question_type: input.question_type ?? "single_choice",
          options: input.options ?? [],
          correct_answers: input.correct_answers ?? [],
          points: input.points ?? 1,
          sequence_no: input.sequence_no ?? 1,
          explanation: input.explanation,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["quiz-questions", quizId] }),
    onError: (e) => toast.error(normalizeError(e).message),
  });

  const removeQuestion = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await sb.from("quiz_questions").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["quiz-questions", quizId] }),
    onError: (e) => toast.error(normalizeError(e).message),
  });

  return { questions: data ?? [], isLoading, addQuestion, removeQuestion };
}

export function useQuizAttemptActions() {
  const qc = useQueryClient();
  const { currentOrg } = useOrganization();

  const start = useMutation({
    mutationFn: async (input: { quiz_id: string; employee_id: string; enrollment_id?: string | null }) => {
      const { data: prev } = await sb
        .from("quiz_attempts")
        .select("attempt_no")
        .eq("quiz_id", input.quiz_id)
        .eq("employee_id", input.employee_id)
        .order("attempt_no", { ascending: false })
        .limit(1);
      const next = ((prev?.[0]?.attempt_no as number | undefined) ?? 0) + 1;
      const { data, error } = await sb
        .from("quiz_attempts")
        .insert({
          organization_id: currentOrg!.id,
          quiz_id: input.quiz_id,
          employee_id: input.employee_id,
          enrollment_id: input.enrollment_id ?? null,
          attempt_no: next,
        })
        .select()
        .single();
      if (error) throw error;
      return data as QuizAttempt;
    },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  const grade = useMutation({
    mutationFn: async (input: { attempt_id: string; answers: Record<string, any> }) => {
      const { data, error } = await sb.rpc("talent_quiz_grade", {
        _attempt_id: input.attempt_id,
        _answers: input.answers,
      });
      if (error) throw error;
      return data as QuizAttempt;
    },
    onSuccess: (att: any) => {
      if (att?.passed) toast.success(`Passed — score ${att.score}`);
      else toast.message(`Submitted — score ${att?.score ?? 0}`);
      qc.invalidateQueries({ queryKey: ["quiz-attempts"] });
    },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  return { start, grade };
}
