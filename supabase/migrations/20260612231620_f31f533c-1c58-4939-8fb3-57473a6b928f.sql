
-- Learning Paths
CREATE TABLE IF NOT EXISTS public.learning_paths (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  name text NOT NULL,
  description text,
  target_role text,
  category text,
  cover_image_url text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_paths TO authenticated;
GRANT ALL ON public.learning_paths TO service_role;
ALTER TABLE public.learning_paths ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Talent admins manage learning paths" ON public.learning_paths
  FOR ALL TO authenticated
  USING (public.is_talent_admin(auth.uid(), organization_id))
  WITH CHECK (public.is_talent_admin(auth.uid(), organization_id));
CREATE POLICY "Employees view active learning paths" ON public.learning_paths
  FOR SELECT TO authenticated
  USING (is_active AND public.current_employee_id(organization_id) IS NOT NULL);
CREATE TRIGGER trg_learning_paths_updated_at BEFORE UPDATE ON public.learning_paths
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.learning_path_courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  path_id uuid NOT NULL REFERENCES public.learning_paths(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.training_courses(id) ON DELETE CASCADE,
  sequence_no integer NOT NULL DEFAULT 1,
  is_required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (path_id, course_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_path_courses TO authenticated;
GRANT ALL ON public.learning_path_courses TO service_role;
ALTER TABLE public.learning_path_courses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Talent admins manage path courses" ON public.learning_path_courses
  FOR ALL TO authenticated
  USING (public.is_talent_admin(auth.uid(), organization_id))
  WITH CHECK (public.is_talent_admin(auth.uid(), organization_id));
CREATE POLICY "Employees view path courses" ON public.learning_path_courses
  FOR SELECT TO authenticated
  USING (public.current_employee_id(organization_id) IS NOT NULL);

CREATE TABLE IF NOT EXISTS public.learning_path_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  path_id uuid NOT NULL REFERENCES public.learning_paths(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled','in_progress','completed','dropped')),
  started_at timestamptz,
  completed_at timestamptz,
  assigned_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (path_id, employee_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_path_enrollments TO authenticated;
GRANT ALL ON public.learning_path_enrollments TO service_role;
ALTER TABLE public.learning_path_enrollments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Talent admins manage path enrollments" ON public.learning_path_enrollments
  FOR ALL TO authenticated
  USING (public.is_talent_admin(auth.uid(), organization_id))
  WITH CHECK (public.is_talent_admin(auth.uid(), organization_id));
CREATE POLICY "Employees manage own path enrollments" ON public.learning_path_enrollments
  FOR ALL TO authenticated
  USING (employee_id = public.current_employee_id(organization_id))
  WITH CHECK (employee_id = public.current_employee_id(organization_id));
CREATE TRIGGER trg_lpe_updated_at BEFORE UPDATE ON public.learning_path_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Quizzes
CREATE TABLE IF NOT EXISTS public.training_quizzes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  course_id uuid NOT NULL REFERENCES public.training_courses(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  pass_score numeric NOT NULL DEFAULT 70,
  time_limit_minutes integer,
  max_attempts integer NOT NULL DEFAULT 3,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.training_quizzes TO authenticated;
GRANT ALL ON public.training_quizzes TO service_role;
ALTER TABLE public.training_quizzes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Talent admins manage quizzes" ON public.training_quizzes
  FOR ALL TO authenticated
  USING (public.is_talent_admin(auth.uid(), organization_id))
  WITH CHECK (public.is_talent_admin(auth.uid(), organization_id));
CREATE POLICY "Employees view active quizzes" ON public.training_quizzes
  FOR SELECT TO authenticated
  USING (is_active AND public.current_employee_id(organization_id) IS NOT NULL);
CREATE TRIGGER trg_quizzes_updated_at BEFORE UPDATE ON public.training_quizzes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.quiz_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  quiz_id uuid NOT NULL REFERENCES public.training_quizzes(id) ON DELETE CASCADE,
  prompt text NOT NULL,
  question_type text NOT NULL DEFAULT 'single_choice' CHECK (question_type IN ('single_choice','multi_choice','true_false','short_text')),
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  correct_answers jsonb NOT NULL DEFAULT '[]'::jsonb,
  points numeric NOT NULL DEFAULT 1,
  sequence_no integer NOT NULL DEFAULT 1,
  explanation text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quiz_questions TO authenticated;
GRANT ALL ON public.quiz_questions TO service_role;
ALTER TABLE public.quiz_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Talent admins manage quiz questions" ON public.quiz_questions
  FOR ALL TO authenticated
  USING (public.is_talent_admin(auth.uid(), organization_id))
  WITH CHECK (public.is_talent_admin(auth.uid(), organization_id));
CREATE POLICY "Employees view quiz questions" ON public.quiz_questions
  FOR SELECT TO authenticated
  USING (public.current_employee_id(organization_id) IS NOT NULL);

CREATE TABLE IF NOT EXISTS public.quiz_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  quiz_id uuid NOT NULL REFERENCES public.training_quizzes(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  enrollment_id uuid REFERENCES public.training_enrollments(id) ON DELETE SET NULL,
  attempt_no integer NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  score numeric,
  passed boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quiz_attempts TO authenticated;
GRANT ALL ON public.quiz_attempts TO service_role;
ALTER TABLE public.quiz_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Talent admins view quiz attempts" ON public.quiz_attempts
  FOR SELECT TO authenticated
  USING (public.is_talent_admin(auth.uid(), organization_id));
CREATE POLICY "Employees manage own quiz attempts" ON public.quiz_attempts
  FOR ALL TO authenticated
  USING (employee_id = public.current_employee_id(organization_id))
  WITH CHECK (employee_id = public.current_employee_id(organization_id));
CREATE TRIGGER trg_quiz_attempts_updated_at BEFORE UPDATE ON public.quiz_attempts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Grade function
CREATE OR REPLACE FUNCTION public.talent_quiz_grade(_attempt_id uuid, _answers jsonb)
RETURNS public.quiz_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _attempt public.quiz_attempts;
  _quiz public.training_quizzes;
  _course public.training_courses;
  _q RECORD;
  _total_points numeric := 0;
  _earned numeric := 0;
  _ans jsonb;
  _is_correct boolean;
  _final_score numeric;
  _passed boolean;
  _comp_id uuid;
BEGIN
  SELECT * INTO _attempt FROM public.quiz_attempts WHERE id = _attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attempt not found'; END IF;
  IF _attempt.employee_id <> public.current_employee_id(_attempt.organization_id) THEN
    RAISE EXCEPTION 'Not your attempt';
  END IF;
  IF _attempt.submitted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Attempt already submitted';
  END IF;

  SELECT * INTO _quiz FROM public.training_quizzes WHERE id = _attempt.quiz_id;
  SELECT * INTO _course FROM public.training_courses WHERE id = _quiz.course_id;

  FOR _q IN SELECT * FROM public.quiz_questions WHERE quiz_id = _quiz.id ORDER BY sequence_no LOOP
    _total_points := _total_points + _q.points;
    _ans := _answers -> _q.id::text;
    _is_correct := FALSE;
    IF _ans IS NOT NULL THEN
      IF _q.question_type IN ('single_choice','true_false','short_text') THEN
        _is_correct := (lower(trim(both '"' from _ans::text)) = lower(trim(both '"' from (_q.correct_answers->0)::text)));
      ELSIF _q.question_type = 'multi_choice' THEN
        _is_correct := (
          (SELECT array_agg(x ORDER BY x) FROM jsonb_array_elements_text(_ans) x)
          = (SELECT array_agg(x ORDER BY x) FROM jsonb_array_elements_text(_q.correct_answers) x)
        );
      END IF;
    END IF;
    IF _is_correct THEN
      _earned := _earned + _q.points;
    END IF;
  END LOOP;

  _final_score := CASE WHEN _total_points > 0 THEN ROUND((_earned / _total_points) * 100, 2) ELSE 0 END;
  _passed := _final_score >= _quiz.pass_score;

  UPDATE public.quiz_attempts
    SET answers = _answers,
        submitted_at = now(),
        score = _final_score,
        passed = _passed,
        updated_at = now()
    WHERE id = _attempt_id
    RETURNING * INTO _attempt;

  -- On pass: update enrollment + upsert competencies
  IF _passed THEN
    IF _attempt.enrollment_id IS NOT NULL THEN
      UPDATE public.training_enrollments
        SET status = 'completed',
            completed_at = COALESCE(completed_at, now()),
            score = GREATEST(COALESCE(score, 0), _final_score),
            updated_at = now()
        WHERE id = _attempt.enrollment_id;
    END IF;

    IF _course.competency_ids IS NOT NULL AND _course.target_level IS NOT NULL THEN
      FOREACH _comp_id IN ARRAY _course.competency_ids LOOP
        INSERT INTO public.employee_competencies (
          organization_id, employee_id, competency_id, level, assessed_at, assessor_user_id, notes
        ) VALUES (
          _attempt.organization_id, _attempt.employee_id, _comp_id, _course.target_level,
          CURRENT_DATE, auth.uid(),
          'Auto-awarded via quiz: ' || _quiz.title
        )
        ON CONFLICT DO NOTHING;
      END LOOP;
    END IF;
  END IF;

  RETURN _attempt;
END;
$$;
REVOKE ALL ON FUNCTION public.talent_quiz_grade(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.talent_quiz_grade(uuid, jsonb) TO authenticated;
