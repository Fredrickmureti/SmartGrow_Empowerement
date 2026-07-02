
CREATE TYPE public.requisition_status AS ENUM ('draft','open','on_hold','filled','closed','cancelled');
CREATE TYPE public.application_stage AS ENUM ('applied','screen','interview','assessment','offer','hired','rejected','withdrawn');
CREATE TYPE public.interview_recommendation AS ENUM ('strong_no','no','maybe','yes','strong_yes');
CREATE TYPE public.offer_status AS ENUM ('draft','sent','accepted','declined','withdrawn','rescinded');

CREATE TABLE public.job_requisitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  title text NOT NULL,
  job_position_id uuid REFERENCES public.job_positions(id),
  department_id uuid REFERENCES public.departments(id),
  work_location_id uuid REFERENCES public.work_locations(id),
  hiring_manager_id uuid REFERENCES public.employees(id),
  headcount integer NOT NULL DEFAULT 1 CHECK (headcount >= 1),
  status public.requisition_status NOT NULL DEFAULT 'draft',
  employment_type text,
  min_salary numeric,
  max_salary numeric,
  currency text,
  description text,
  opened_at timestamptz,
  closed_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_requisitions TO authenticated;
GRANT ALL ON public.job_requisitions TO service_role;
ALTER TABLE public.job_requisitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "req read org members" ON public.job_requisitions FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "req write hr" ON public.job_requisitions FOR ALL TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text))
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text));
CREATE TRIGGER trg_job_requisitions_updated_at BEFORE UPDATE ON public.job_requisitions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  full_name text NOT NULL,
  email text,
  phone text,
  source text,
  linkedin_url text,
  resume_url text,
  current_title text,
  current_company text,
  tags text[] NOT NULL DEFAULT '{}',
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT candidates_email_unique_per_org UNIQUE (organization_id, email)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.candidates TO authenticated;
GRANT INSERT ON public.candidates TO anon;
GRANT ALL ON public.candidates TO service_role;
ALTER TABLE public.candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cand read org" ON public.candidates FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "cand write hr" ON public.candidates FOR ALL TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text))
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text));
CREATE POLICY "cand insert anon careers" ON public.candidates FOR INSERT TO anon WITH CHECK (true);
CREATE TRIGGER trg_candidates_updated_at BEFORE UPDATE ON public.candidates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.candidate_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  requisition_id uuid NOT NULL REFERENCES public.job_requisitions(id) ON DELETE CASCADE,
  stage public.application_stage NOT NULL DEFAULT 'applied',
  rejection_reason text,
  applied_at timestamptz NOT NULL DEFAULT now(),
  stage_updated_at timestamptz NOT NULL DEFAULT now(),
  converted_employee_id uuid REFERENCES public.employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, requisition_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.candidate_applications TO authenticated;
GRANT ALL ON public.candidate_applications TO service_role;
ALTER TABLE public.candidate_applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "app read org" ON public.candidate_applications FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "app write hr" ON public.candidate_applications FOR ALL TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text))
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text));
CREATE TRIGGER trg_candidate_applications_updated_at BEFORE UPDATE ON public.candidate_applications FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.touch_application_stage()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.stage IS DISTINCT FROM OLD.stage THEN
    NEW.stage_updated_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_application_stage_touch BEFORE UPDATE ON public.candidate_applications FOR EACH ROW EXECUTE FUNCTION public.touch_application_stage();

CREATE TABLE public.interview_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL REFERENCES public.candidate_applications(id) ON DELETE CASCADE,
  reviewer_user_id uuid NOT NULL,
  stage_name text,
  rating smallint CHECK (rating BETWEEN 1 AND 5),
  recommendation public.interview_recommendation,
  strengths text,
  concerns text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.interview_feedback TO authenticated;
GRANT ALL ON public.interview_feedback TO service_role;
ALTER TABLE public.interview_feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fb read org" ON public.interview_feedback FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "fb insert reviewer" ON public.interview_feedback FOR INSERT TO authenticated WITH CHECK (reviewer_user_id = auth.uid() AND public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "fb update reviewer" ON public.interview_feedback FOR UPDATE TO authenticated USING (reviewer_user_id = auth.uid()) WITH CHECK (reviewer_user_id = auth.uid());
CREATE POLICY "fb delete hr" ON public.interview_feedback FOR DELETE TO authenticated USING (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'delete'::text));
CREATE TRIGGER trg_interview_feedback_updated_at BEFORE UPDATE ON public.interview_feedback FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.offer_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  application_id uuid NOT NULL REFERENCES public.candidate_applications(id) ON DELETE CASCADE,
  status public.offer_status NOT NULL DEFAULT 'draft',
  base_salary numeric,
  currency text,
  bonus_target numeric,
  start_date date,
  expires_at timestamptz,
  sent_at timestamptz,
  decision_at timestamptz,
  letter_body text,
  notes text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.offer_letters TO authenticated;
GRANT ALL ON public.offer_letters TO service_role;
ALTER TABLE public.offer_letters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "off read org" ON public.offer_letters FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "off write hr" ON public.offer_letters FOR ALL TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text))
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'employees'::text, 'write'::text));
CREATE TRIGGER trg_offer_letters_updated_at BEFORE UPDATE ON public.offer_letters FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.convert_application_to_employee(
  p_application_id uuid,
  p_employee_payload jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_app public.candidate_applications;
  v_cand public.candidates;
  v_req  public.job_requisitions;
  v_new_employee_id uuid;
BEGIN
  SELECT * INTO v_app FROM public.candidate_applications WHERE id = p_application_id;
  IF v_app.id IS NULL THEN
    RAISE EXCEPTION 'Application not found' USING HINT = 'RECRUITMENT_APP_NOT_FOUND';
  END IF;
  IF NOT public.user_has_module_permission(auth.uid(), v_app.organization_id, 'employees'::text, 'write'::text) THEN
    RAISE EXCEPTION 'Not authorized to convert applications' USING HINT = 'RECRUITMENT_FORBIDDEN';
  END IF;
  IF v_app.stage NOT IN ('offer','hired') THEN
    RAISE EXCEPTION 'Application must be in offer or hired stage' USING HINT = 'RECRUITMENT_STAGE_INVALID';
  END IF;
  IF v_app.converted_employee_id IS NOT NULL THEN
    RETURN v_app.converted_employee_id;
  END IF;

  SELECT * INTO v_cand FROM public.candidates WHERE id = v_app.candidate_id;
  SELECT * INTO v_req  FROM public.job_requisitions WHERE id = v_app.requisition_id;

  INSERT INTO public.employees (
    organization_id, business_id,
    first_name, last_name, email, phone,
    job_position_id, department_id, hire_date,
    employment_type, basic_salary, is_active, created_by
  ) VALUES (
    v_app.organization_id, v_app.business_id,
    COALESCE(p_employee_payload->>'first_name', split_part(v_cand.full_name, ' ', 1)),
    COALESCE(p_employee_payload->>'last_name',  NULLIF(regexp_replace(v_cand.full_name, '^\S+\s*', ''), '')),
    COALESCE(p_employee_payload->>'email', v_cand.email),
    COALESCE(p_employee_payload->>'phone', v_cand.phone),
    COALESCE((p_employee_payload->>'job_position_id')::uuid, v_req.job_position_id),
    COALESCE((p_employee_payload->>'department_id')::uuid,   v_req.department_id),
    COALESCE((p_employee_payload->>'hire_date')::date, CURRENT_DATE),
    COALESCE(p_employee_payload->>'employment_type', v_req.employment_type, 'full_time'),
    COALESCE((p_employee_payload->>'basic_salary')::numeric, 0),
    true, auth.uid()
  ) RETURNING id INTO v_new_employee_id;

  UPDATE public.candidate_applications
     SET stage = 'hired', converted_employee_id = v_new_employee_id
   WHERE id = v_app.id;

  IF v_req.headcount <= (
    SELECT count(*) FROM public.candidate_applications
     WHERE requisition_id = v_req.id AND stage = 'hired'
  ) THEN
    UPDATE public.job_requisitions
       SET status = 'filled', closed_at = now()
     WHERE id = v_req.id;
  END IF;

  RETURN v_new_employee_id;
END $$;

REVOKE ALL ON FUNCTION public.convert_application_to_employee(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.convert_application_to_employee(uuid, jsonb) TO authenticated;

CREATE INDEX idx_job_requisitions_org_status ON public.job_requisitions(organization_id, status);
CREATE INDEX idx_candidates_org ON public.candidates(organization_id);
CREATE INDEX idx_candidate_applications_req ON public.candidate_applications(requisition_id, stage);
CREATE INDEX idx_interview_feedback_app ON public.interview_feedback(application_id);
CREATE INDEX idx_offer_letters_app ON public.offer_letters(application_id);
