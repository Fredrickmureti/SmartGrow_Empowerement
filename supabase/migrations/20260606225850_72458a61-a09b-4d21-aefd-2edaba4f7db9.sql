
CREATE TYPE public.performance_cycle_status AS ENUM ('draft','open','in_progress','closed');
CREATE TYPE public.performance_review_status AS ENUM ('not_started','in_progress','submitted','acknowledged');
CREATE TYPE public.goal_status AS ENUM ('not_started','in_progress','at_risk','completed','cancelled');
CREATE TYPE public.training_enrollment_status AS ENUM ('enrolled','in_progress','completed','dropped','failed');

CREATE TABLE public.performance_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  name text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status public.performance_cycle_status NOT NULL DEFAULT 'draft',
  description text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.performance_cycles TO authenticated;
GRANT ALL ON public.performance_cycles TO service_role;
ALTER TABLE public.performance_cycles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pcycle read" ON public.performance_cycles FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "pcycle write hr" ON public.performance_cycles FOR ALL TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text))
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text));
CREATE TRIGGER trg_performance_cycles_updated_at BEFORE UPDATE ON public.performance_cycles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.performance_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  cycle_id uuid NOT NULL REFERENCES public.performance_cycles(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  reviewer_user_id uuid NOT NULL,
  status public.performance_review_status NOT NULL DEFAULT 'not_started',
  overall_rating smallint CHECK (overall_rating BETWEEN 1 AND 5),
  summary text,
  strengths text,
  development_areas text,
  submitted_at timestamptz,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, employee_id, reviewer_user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.performance_reviews TO authenticated;
GRANT ALL ON public.performance_reviews TO service_role;
ALTER TABLE public.performance_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY "preview read org" ON public.performance_reviews FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "preview write reviewer" ON public.performance_reviews FOR UPDATE TO authenticated USING (reviewer_user_id = auth.uid()) WITH CHECK (reviewer_user_id = auth.uid());
CREATE POLICY "preview write hr" ON public.performance_reviews FOR ALL TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text))
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text));
CREATE TRIGGER trg_performance_reviews_updated_at BEFORE UPDATE ON public.performance_reviews FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.performance_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  cycle_id uuid REFERENCES public.performance_cycles(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  target_date date,
  status public.goal_status NOT NULL DEFAULT 'not_started',
  progress_pct smallint NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.performance_goals TO authenticated;
GRANT ALL ON public.performance_goals TO service_role;
ALTER TABLE public.performance_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pgoal read org" ON public.performance_goals FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "pgoal write self or hr" ON public.performance_goals FOR ALL TO authenticated
  USING (
    employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
    OR public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text)
  )
  WITH CHECK (
    employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
    OR public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text)
  );
CREATE TRIGGER trg_performance_goals_updated_at BEFORE UPDATE ON public.performance_goals FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.goal_check_ins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  goal_id uuid NOT NULL REFERENCES public.performance_goals(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL,
  note text NOT NULL,
  progress_pct smallint CHECK (progress_pct BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.goal_check_ins TO authenticated;
GRANT ALL ON public.goal_check_ins TO service_role;
ALTER TABLE public.goal_check_ins ENABLE ROW LEVEL SECURITY;
CREATE POLICY "checkin read org" ON public.goal_check_ins FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "checkin insert self" ON public.goal_check_ins FOR INSERT TO authenticated WITH CHECK (author_user_id = auth.uid() AND public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "checkin delete self" ON public.goal_check_ins FOR DELETE TO authenticated USING (author_user_id = auth.uid());

CREATE TABLE public.training_courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  name text NOT NULL,
  description text,
  provider text,
  duration_hours numeric,
  category text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.training_courses TO authenticated;
GRANT ALL ON public.training_courses TO service_role;
ALTER TABLE public.training_courses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "course read" ON public.training_courses FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "course write hr" ON public.training_courses FOR ALL TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text))
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text));
CREATE TRIGGER trg_training_courses_updated_at BEFORE UPDATE ON public.training_courses FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.training_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  course_id uuid NOT NULL REFERENCES public.training_courses(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  status public.training_enrollment_status NOT NULL DEFAULT 'enrolled',
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  score numeric,
  certificate_url text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, employee_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.training_enrollments TO authenticated;
GRANT ALL ON public.training_enrollments TO service_role;
ALTER TABLE public.training_enrollments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "enrol read" ON public.training_enrollments FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "enrol write hr" ON public.training_enrollments FOR ALL TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text))
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text));
CREATE POLICY "enrol self update progress" ON public.training_enrollments FOR UPDATE TO authenticated
  USING (employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()))
  WITH CHECK (employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()));
CREATE TRIGGER trg_training_enrollments_updated_at BEFORE UPDATE ON public.training_enrollments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.competencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  category text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.competencies TO authenticated;
GRANT ALL ON public.competencies TO service_role;
ALTER TABLE public.competencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "comp read" ON public.competencies FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "comp write hr" ON public.competencies FOR ALL TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text))
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text));
CREATE TRIGGER trg_competencies_updated_at BEFORE UPDATE ON public.competencies FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.employee_competencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  competency_id uuid NOT NULL REFERENCES public.competencies(id) ON DELETE CASCADE,
  level smallint NOT NULL CHECK (level BETWEEN 1 AND 5),
  assessed_at date NOT NULL DEFAULT CURRENT_DATE,
  assessor_user_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, competency_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_competencies TO authenticated;
GRANT ALL ON public.employee_competencies TO service_role;
ALTER TABLE public.employee_competencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ecomp read" ON public.employee_competencies FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "ecomp write hr" ON public.employee_competencies FOR ALL TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text))
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text));
CREATE TRIGGER trg_employee_competencies_updated_at BEFORE UPDATE ON public.employee_competencies FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_perf_reviews_cycle_emp ON public.performance_reviews(cycle_id, employee_id);
CREATE INDEX idx_perf_goals_emp ON public.performance_goals(employee_id, status);
CREATE INDEX idx_training_enrol_emp ON public.training_enrollments(employee_id, status);
CREATE INDEX idx_employee_comp_emp ON public.employee_competencies(employee_id);
