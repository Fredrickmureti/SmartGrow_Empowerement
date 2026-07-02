
-- =====================================================================
-- TALENT MANAGEMENT — STEP 1: SECURITY & INTEGRITY HARDENING (v2)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tighten competency_scales RLS (was USING (true))
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "competency_scales org read"  ON public.competency_scales;
DROP POLICY IF EXISTS "competency_scales org write" ON public.competency_scales;

CREATE POLICY "competency_scales select org members"
ON public.competency_scales
FOR SELECT
TO authenticated
USING (
  organization_id IN (
    SELECT uba.organization_id
    FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
  )
);

CREATE POLICY "competency_scales write hr"
ON public.competency_scales
FOR ALL
TO authenticated
USING (
  public.has_role(auth.uid(), organization_id, 'admin'::app_role)
  OR public.has_role(auth.uid(), organization_id, 'owner'::app_role)
)
WITH CHECK (
  public.has_role(auth.uid(), organization_id, 'admin'::app_role)
  OR public.has_role(auth.uid(), organization_id, 'owner'::app_role)
);


-- ---------------------------------------------------------------------
-- 2. talent_audit_log
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.talent_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  actor_user_id   uuid NOT NULL,
  action          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  before_state    jsonb,
  after_state     jsonb,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS talent_audit_log_org_created_idx
  ON public.talent_audit_log (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS talent_audit_log_entity_idx
  ON public.talent_audit_log (entity_type, entity_id);

GRANT SELECT ON public.talent_audit_log TO authenticated;
GRANT ALL    ON public.talent_audit_log TO service_role;

ALTER TABLE public.talent_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "talent_audit_log hr read" ON public.talent_audit_log;
CREATE POLICY "talent_audit_log hr read"
ON public.talent_audit_log
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), organization_id, 'admin'::app_role)
  OR public.has_role(auth.uid(), organization_id, 'owner'::app_role)
);


-- ---------------------------------------------------------------------
-- 3. Guard helper
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._talent_guard_on()
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN COALESCE(current_setting('talent.bypass_guard', true), 'off') = 'on';
END;
$$;


-- ---------------------------------------------------------------------
-- 4. performance_reviews guard trigger
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._talent_guard_performance_reviews()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public._talent_guard_on() THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status IN ('submitted', 'signed_off', 'acknowledged') THEN
      RAISE EXCEPTION
        'performance_reviews: status transition to "%" must go through a talent_* RPC',
        NEW.status
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.signed_off_at     IS DISTINCT FROM OLD.signed_off_at
  OR NEW.signed_off_by     IS DISTINCT FROM OLD.signed_off_by
  OR NEW.acknowledged_at   IS DISTINCT FROM OLD.acknowledged_at
  OR NEW.submitted_at      IS DISTINCT FROM OLD.submitted_at
  OR NEW.final_rating      IS DISTINCT FROM OLD.final_rating
  OR NEW.calibration_notes IS DISTINCT FROM OLD.calibration_notes THEN
    RAISE EXCEPTION
      'performance_reviews: protected fields must be set via talent_* RPCs'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS talent_guard_performance_reviews ON public.performance_reviews;
CREATE TRIGGER talent_guard_performance_reviews
  BEFORE UPDATE ON public.performance_reviews
  FOR EACH ROW EXECUTE FUNCTION public._talent_guard_performance_reviews();


-- ---------------------------------------------------------------------
-- 5. performance_cycles guard trigger
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._talent_guard_performance_cycles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public._talent_guard_on() THEN
    RETURN NEW;
  END IF;
  IF NEW.phase IS DISTINCT FROM OLD.phase THEN
    RAISE EXCEPTION
      'performance_cycles: phase changes must go through talent_advance_cycle_phase()'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS talent_guard_performance_cycles ON public.performance_cycles;
CREATE TRIGGER talent_guard_performance_cycles
  BEFORE UPDATE ON public.performance_cycles
  FOR EACH ROW EXECUTE FUNCTION public._talent_guard_performance_cycles();


-- ---------------------------------------------------------------------
-- 6. RPC: advance cycle phase
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.talent_advance_cycle_phase(
  _cycle_id   uuid,
  _next_phase text
)
RETURNS public.performance_cycles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _cycle  public.performance_cycles%ROWTYPE;
  _before jsonb;
  _after  jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO _cycle FROM public.performance_cycles WHERE id = _cycle_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cycle % not found', _cycle_id USING ERRCODE = '02000';
  END IF;

  IF NOT (public.has_role(auth.uid(), _cycle.organization_id, 'admin'::app_role)
          OR public.has_role(auth.uid(), _cycle.organization_id, 'owner'::app_role)) THEN
    RAISE EXCEPTION 'Only HR admins or owners may advance cycle phase'
      USING ERRCODE = '42501';
  END IF;

  IF _next_phase NOT IN ('draft','goal_setting','in_progress','self_review','manager_review','calibration','sign_off','closed') THEN
    RAISE EXCEPTION 'Invalid phase "%"', _next_phase USING ERRCODE = '22023';
  END IF;

  _before := to_jsonb(_cycle);
  PERFORM set_config('talent.bypass_guard', 'on', true);
  UPDATE public.performance_cycles
     SET phase = _next_phase, updated_at = now()
   WHERE id = _cycle_id
  RETURNING * INTO _cycle;
  PERFORM set_config('talent.bypass_guard', 'off', true);
  _after := to_jsonb(_cycle);

  INSERT INTO public.talent_audit_log (organization_id, actor_user_id, action, entity_type, entity_id, before_state, after_state)
  VALUES (_cycle.organization_id, auth.uid(), 'cycle.advance_phase', 'performance_cycle', _cycle.id, _before, _after);

  RETURN _cycle;
END;
$$;
REVOKE ALL ON FUNCTION public.talent_advance_cycle_phase(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.talent_advance_cycle_phase(uuid, text) TO authenticated;


-- ---------------------------------------------------------------------
-- 7. RPC: submit a review (only the assigned reviewer)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.talent_submit_review(
  _review_id          uuid,
  _overall_rating     numeric DEFAULT NULL,
  _summary            text    DEFAULT NULL,
  _strengths          text    DEFAULT NULL,
  _development_areas  text    DEFAULT NULL
)
RETURNS public.performance_reviews
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _r      public.performance_reviews%ROWTYPE;
  _before jsonb;
  _after  jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO _r FROM public.performance_reviews WHERE id = _review_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review % not found', _review_id USING ERRCODE = '02000';
  END IF;

  IF _r.reviewer_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the assigned reviewer may submit this review'
      USING ERRCODE = '42501';
  END IF;

  IF _r.status NOT IN ('draft','in_progress') THEN
    RAISE EXCEPTION 'Cannot submit a review in status "%"', _r.status
      USING ERRCODE = '22023';
  END IF;

  _before := to_jsonb(_r);
  PERFORM set_config('talent.bypass_guard', 'on', true);
  UPDATE public.performance_reviews
     SET status            = 'submitted',
         submitted_at      = now(),
         overall_rating    = COALESCE(_overall_rating, overall_rating),
         summary           = COALESCE(_summary,        summary),
         strengths         = COALESCE(_strengths,      strengths),
         development_areas = COALESCE(_development_areas, development_areas),
         updated_at        = now()
   WHERE id = _review_id
  RETURNING * INTO _r;
  PERFORM set_config('talent.bypass_guard', 'off', true);
  _after := to_jsonb(_r);

  INSERT INTO public.talent_audit_log (organization_id, actor_user_id, action, entity_type, entity_id, before_state, after_state)
  VALUES (_r.organization_id, auth.uid(), 'review.submit', 'performance_review', _r.id, _before, _after);

  RETURN _r;
END;
$$;
REVOKE ALL ON FUNCTION public.talent_submit_review(uuid, numeric, text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.talent_submit_review(uuid, numeric, text, text, text) TO authenticated;


-- ---------------------------------------------------------------------
-- 8. RPC: sign off (employee's manager OR HR admin/owner)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.talent_sign_off_review(
  _review_id          uuid,
  _final_rating       numeric DEFAULT NULL,
  _calibration_notes  text    DEFAULT NULL
)
RETURNS public.performance_reviews
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _r      public.performance_reviews%ROWTYPE;
  _before jsonb;
  _after  jsonb;
  _is_mgr boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO _r FROM public.performance_reviews WHERE id = _review_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review % not found', _review_id USING ERRCODE = '02000';
  END IF;

  SELECT public.is_manager_of(auth.uid(), _r.employee_id) INTO _is_mgr;

  IF NOT (COALESCE(_is_mgr, false)
          OR public.has_role(auth.uid(), _r.organization_id, 'admin'::app_role)
          OR public.has_role(auth.uid(), _r.organization_id, 'owner'::app_role)) THEN
    RAISE EXCEPTION 'Only the employee''s manager or HR admins/owners may sign off'
      USING ERRCODE = '42501';
  END IF;

  IF _r.status NOT IN ('submitted','in_progress','draft') THEN
    RAISE EXCEPTION 'Cannot sign off a review in status "%"', _r.status
      USING ERRCODE = '22023';
  END IF;

  _before := to_jsonb(_r);
  PERFORM set_config('talent.bypass_guard', 'on', true);
  UPDATE public.performance_reviews
     SET status            = 'signed_off',
         signed_off_at     = now(),
         signed_off_by     = auth.uid(),
         final_rating      = COALESCE(_final_rating, final_rating, overall_rating),
         calibration_notes = COALESCE(_calibration_notes, calibration_notes),
         updated_at        = now()
   WHERE id = _review_id
  RETURNING * INTO _r;
  PERFORM set_config('talent.bypass_guard', 'off', true);
  _after := to_jsonb(_r);

  INSERT INTO public.talent_audit_log (organization_id, actor_user_id, action, entity_type, entity_id, before_state, after_state)
  VALUES (_r.organization_id, auth.uid(), 'review.sign_off', 'performance_review', _r.id, _before, _after);

  RETURN _r;
END;
$$;
REVOKE ALL ON FUNCTION public.talent_sign_off_review(uuid, numeric, text) FROM public;
GRANT EXECUTE ON FUNCTION public.talent_sign_off_review(uuid, numeric, text) TO authenticated;


-- ---------------------------------------------------------------------
-- 9. RPC: acknowledge (the reviewed employee only)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.talent_acknowledge_review(_review_id uuid)
RETURNS public.performance_reviews
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _r       public.performance_reviews%ROWTYPE;
  _emp_uid uuid;
  _before  jsonb;
  _after   jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO _r FROM public.performance_reviews WHERE id = _review_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review % not found', _review_id USING ERRCODE = '02000';
  END IF;

  SELECT e.user_id INTO _emp_uid FROM public.employees e WHERE e.id = _r.employee_id;

  IF _emp_uid IS NULL OR _emp_uid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the reviewed employee may acknowledge this review'
      USING ERRCODE = '42501';
  END IF;

  IF _r.status <> 'signed_off' THEN
    RAISE EXCEPTION 'Only signed-off reviews may be acknowledged (current: %)', _r.status
      USING ERRCODE = '22023';
  END IF;

  _before := to_jsonb(_r);
  PERFORM set_config('talent.bypass_guard', 'on', true);
  UPDATE public.performance_reviews
     SET status          = 'acknowledged',
         acknowledged_at = now(),
         updated_at      = now()
   WHERE id = _review_id
  RETURNING * INTO _r;
  PERFORM set_config('talent.bypass_guard', 'off', true);
  _after := to_jsonb(_r);

  INSERT INTO public.talent_audit_log (organization_id, actor_user_id, action, entity_type, entity_id, before_state, after_state)
  VALUES (_r.organization_id, auth.uid(), 'review.acknowledge', 'performance_review', _r.id, _before, _after);

  RETURN _r;
END;
$$;
REVOKE ALL ON FUNCTION public.talent_acknowledge_review(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.talent_acknowledge_review(uuid) TO authenticated;


-- ---------------------------------------------------------------------
-- 10. RPC: calibrate a review (HR admin/owner)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.talent_calibrate_review(
  _review_id          uuid,
  _final_rating       numeric,
  _calibration_notes  text DEFAULT NULL
)
RETURNS public.performance_reviews
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _r      public.performance_reviews%ROWTYPE;
  _before jsonb;
  _after  jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO _r FROM public.performance_reviews WHERE id = _review_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review % not found', _review_id USING ERRCODE = '02000';
  END IF;

  IF NOT (public.has_role(auth.uid(), _r.organization_id, 'admin'::app_role)
          OR public.has_role(auth.uid(), _r.organization_id, 'owner'::app_role)) THEN
    RAISE EXCEPTION 'Only HR admins or owners may calibrate' USING ERRCODE = '42501';
  END IF;

  _before := to_jsonb(_r);
  PERFORM set_config('talent.bypass_guard', 'on', true);
  UPDATE public.performance_reviews
     SET final_rating      = _final_rating,
         calibration_notes = COALESCE(_calibration_notes, calibration_notes),
         updated_at        = now()
   WHERE id = _review_id
  RETURNING * INTO _r;
  PERFORM set_config('talent.bypass_guard', 'off', true);
  _after := to_jsonb(_r);

  INSERT INTO public.talent_audit_log (organization_id, actor_user_id, action, entity_type, entity_id, before_state, after_state)
  VALUES (_r.organization_id, auth.uid(), 'review.calibrate', 'performance_review', _r.id, _before, _after);

  RETURN _r;
END;
$$;
REVOKE ALL ON FUNCTION public.talent_calibrate_review(uuid, numeric, text) FROM public;
GRANT EXECUTE ON FUNCTION public.talent_calibrate_review(uuid, numeric, text) TO authenticated;
