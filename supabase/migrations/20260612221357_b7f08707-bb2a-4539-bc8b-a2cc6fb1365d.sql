
-- =====================================================================
-- Phase C: review-cycle automation & calibration sessions
-- =====================================================================

-- 1. calibration_sessions
CREATE TABLE IF NOT EXISTS public.calibration_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  cycle_id        uuid NOT NULL REFERENCES public.performance_cycles(id) ON DELETE CASCADE,
  name            text NOT NULL,
  scheduled_at    timestamptz,
  location        text,
  facilitator_user_id uuid,
  status          text NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
  notes           text,
  scope_department_ids uuid[],
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calib_sessions_cycle ON public.calibration_sessions(cycle_id);
CREATE INDEX IF NOT EXISTS idx_calib_sessions_org   ON public.calibration_sessions(organization_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.calibration_sessions TO authenticated;
GRANT ALL ON public.calibration_sessions TO service_role;
ALTER TABLE public.calibration_sessions ENABLE ROW LEVEL SECURITY;

-- 2. calibration_session_participants
CREATE TABLE IF NOT EXISTS public.calibration_session_participants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES public.calibration_sessions(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  participant_user_id uuid NOT NULL,
  role            text NOT NULL DEFAULT 'manager'
                  CHECK (role IN ('facilitator','manager','hr','observer')),
  attended        boolean,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, participant_user_id)
);
CREATE INDEX IF NOT EXISTS idx_calib_sp_session ON public.calibration_session_participants(session_id);
CREATE INDEX IF NOT EXISTS idx_calib_sp_user    ON public.calibration_session_participants(participant_user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.calibration_session_participants TO authenticated;
GRANT ALL ON public.calibration_session_participants TO service_role;
ALTER TABLE public.calibration_session_participants ENABLE ROW LEVEL SECURITY;

-- 3. calibration_adjustments
CREATE TABLE IF NOT EXISTS public.calibration_adjustments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  session_id      uuid REFERENCES public.calibration_sessions(id) ON DELETE SET NULL,
  cycle_id        uuid NOT NULL REFERENCES public.performance_cycles(id) ON DELETE CASCADE,
  review_id       uuid NOT NULL REFERENCES public.performance_reviews(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL,
  original_rating numeric,
  proposed_rating numeric NOT NULL,
  rationale       text NOT NULL,
  proposed_by     uuid NOT NULL,
  decision        text NOT NULL DEFAULT 'pending'
                  CHECK (decision IN ('pending','approved','rejected','withdrawn')),
  decided_by      uuid,
  decided_at      timestamptz,
  applied_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calib_adj_review  ON public.calibration_adjustments(review_id);
CREATE INDEX IF NOT EXISTS idx_calib_adj_session ON public.calibration_adjustments(session_id);
CREATE INDEX IF NOT EXISTS idx_calib_adj_cycle   ON public.calibration_adjustments(cycle_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.calibration_adjustments TO authenticated;
GRANT ALL ON public.calibration_adjustments TO service_role;
ALTER TABLE public.calibration_adjustments ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "calib_sessions hr manage" ON public.calibration_sessions FOR ALL TO authenticated
  USING (public.is_talent_admin(auth.uid(), organization_id))
  WITH CHECK (public.is_talent_admin(auth.uid(), organization_id));
CREATE POLICY "calib_sessions participant read" ON public.calibration_sessions FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.calibration_session_participants p
    WHERE p.session_id = calibration_sessions.id AND p.participant_user_id = auth.uid()
  ));

CREATE POLICY "calib_sp hr manage" ON public.calibration_session_participants FOR ALL TO authenticated
  USING (public.is_talent_admin(auth.uid(), organization_id))
  WITH CHECK (public.is_talent_admin(auth.uid(), organization_id));
CREATE POLICY "calib_sp self read" ON public.calibration_session_participants FOR SELECT TO authenticated
  USING (participant_user_id = auth.uid());

CREATE POLICY "calib_adj hr manage" ON public.calibration_adjustments FOR ALL TO authenticated
  USING (public.is_talent_admin(auth.uid(), organization_id))
  WITH CHECK (public.is_talent_admin(auth.uid(), organization_id));
CREATE POLICY "calib_adj session participant read" ON public.calibration_adjustments FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.calibration_session_participants p
    WHERE p.session_id = calibration_adjustments.session_id AND p.participant_user_id = auth.uid()
  ));
CREATE POLICY "calib_adj session participant propose" ON public.calibration_adjustments FOR INSERT TO authenticated
  WITH CHECK (
    proposed_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.calibration_session_participants p
      WHERE p.session_id = calibration_adjustments.session_id AND p.participant_user_id = auth.uid()
    )
  );

-- Audit triggers
DROP TRIGGER IF EXISTS calib_sessions_audit ON public.calibration_sessions;
CREATE TRIGGER calib_sessions_audit AFTER INSERT OR UPDATE OR DELETE ON public.calibration_sessions
  FOR EACH ROW EXECUTE FUNCTION public._talent_audit_trigger();
DROP TRIGGER IF EXISTS calib_adj_audit ON public.calibration_adjustments;
CREATE TRIGGER calib_adj_audit AFTER INSERT OR UPDATE OR DELETE ON public.calibration_adjustments
  FOR EACH ROW EXECUTE FUNCTION public._talent_audit_trigger();

-- updated_at triggers
CREATE OR REPLACE FUNCTION public._calib_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS calib_sessions_touch ON public.calibration_sessions;
CREATE TRIGGER calib_sessions_touch BEFORE UPDATE ON public.calibration_sessions
  FOR EACH ROW EXECUTE FUNCTION public._calib_touch_updated_at();
DROP TRIGGER IF EXISTS calib_adj_touch ON public.calibration_adjustments;
CREATE TRIGGER calib_adj_touch BEFORE UPDATE ON public.calibration_adjustments
  FOR EACH ROW EXECUTE FUNCTION public._calib_touch_updated_at();

-- 4. RPC: bulk create reviews for a cycle
CREATE OR REPLACE FUNCTION public.talent_bulk_create_reviews(
  _cycle_id uuid, _review_type text
)
RETURNS TABLE (created_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _cycle public.performance_cycles%ROWTYPE;
  _count integer := 0;
  _r record;
  _inserted_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  SELECT * INTO _cycle FROM public.performance_cycles WHERE id = _cycle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cycle % not found', _cycle_id USING ERRCODE = '02000'; END IF;
  IF NOT public.is_talent_admin(auth.uid(), _cycle.organization_id) THEN
    RAISE EXCEPTION 'Only HR admins may bulk create reviews' USING ERRCODE = '42501';
  END IF;
  IF _review_type NOT IN ('self','manager') THEN
    RAISE EXCEPTION 'Invalid review_type %', _review_type USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('talent.bypass_guard','on',true);
  FOR _r IN
    SELECT e.id AS employee_id, e.user_id, e.manager_id, m.user_id AS manager_user_id, e.department_id
      FROM public.employees e
      LEFT JOIN public.employees m ON m.id = e.manager_id
     WHERE e.organization_id = _cycle.organization_id
       AND COALESCE(e.lifecycle_status,'active') = 'active'
       AND (
         _cycle.scope = 'organization'
         OR (_cycle.scope = 'department'
             AND _cycle.scope_department_ids IS NOT NULL
             AND e.department_id = ANY(_cycle.scope_department_ids))
       )
  LOOP
    IF _review_type = 'self' AND _r.user_id IS NOT NULL THEN
      INSERT INTO public.performance_reviews
        (organization_id, cycle_id, employee_id, reviewer_user_id, review_type, status, template_id, due_at)
      SELECT _cycle.organization_id, _cycle.id, _r.employee_id, _r.user_id, 'self', 'pending',
             _cycle.default_template_id, _cycle.self_review_due_at
      WHERE NOT EXISTS (
        SELECT 1 FROM public.performance_reviews x
         WHERE x.cycle_id = _cycle.id AND x.employee_id = _r.employee_id AND x.review_type = 'self'
      )
      RETURNING id INTO _inserted_id;
      IF _inserted_id IS NOT NULL THEN _count := _count + 1; _inserted_id := NULL; END IF;
    ELSIF _review_type = 'manager' AND _r.manager_user_id IS NOT NULL THEN
      INSERT INTO public.performance_reviews
        (organization_id, cycle_id, employee_id, reviewer_user_id, review_type, status, template_id, due_at)
      SELECT _cycle.organization_id, _cycle.id, _r.employee_id, _r.manager_user_id, 'manager', 'pending',
             _cycle.default_template_id, _cycle.manager_review_due_at
      WHERE NOT EXISTS (
        SELECT 1 FROM public.performance_reviews x
         WHERE x.cycle_id = _cycle.id AND x.employee_id = _r.employee_id AND x.review_type = 'manager'
      )
      RETURNING id INTO _inserted_id;
      IF _inserted_id IS NOT NULL THEN _count := _count + 1; _inserted_id := NULL; END IF;
    END IF;
  END LOOP;
  PERFORM set_config('talent.bypass_guard','off',true);

  INSERT INTO public.talent_audit_log (organization_id, actor_user_id, action, entity_type, entity_id, after_state)
  VALUES (_cycle.organization_id, auth.uid(), 'cycle.bulk_create_reviews', 'performance_cycle', _cycle.id,
          jsonb_build_object('review_type',_review_type,'count',_count));

  RETURN QUERY SELECT _count;
END;
$$;
REVOKE ALL ON FUNCTION public.talent_bulk_create_reviews(uuid,text) FROM public;
GRANT EXECUTE ON FUNCTION public.talent_bulk_create_reviews(uuid,text) TO authenticated;

-- 5. RPC: apply a calibration adjustment
CREATE OR REPLACE FUNCTION public.talent_calibration_apply_adjustment(_adjustment_id uuid)
RETURNS public.calibration_adjustments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _adj public.calibration_adjustments%ROWTYPE;
  _review public.performance_reviews%ROWTYPE;
  _before jsonb; _after jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  SELECT * INTO _adj FROM public.calibration_adjustments WHERE id = _adjustment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Adjustment % not found', _adjustment_id USING ERRCODE = '02000'; END IF;
  IF NOT public.is_talent_admin(auth.uid(), _adj.organization_id) THEN
    RAISE EXCEPTION 'Only HR admins may apply calibration adjustments' USING ERRCODE = '42501';
  END IF;
  IF _adj.decision <> 'pending' THEN
    RAISE EXCEPTION 'Adjustment already %', _adj.decision USING ERRCODE = '22023';
  END IF;
  SELECT * INTO _review FROM public.performance_reviews WHERE id = _adj.review_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Review % not found', _adj.review_id USING ERRCODE = '02000'; END IF;
  _before := to_jsonb(_review);

  PERFORM set_config('talent.bypass_guard','on',true);
  UPDATE public.performance_reviews
     SET final_rating = _adj.proposed_rating,
         calibration_notes = COALESCE(calibration_notes || E'\n---\n','') || _adj.rationale,
         updated_at = now()
   WHERE id = _adj.review_id
  RETURNING * INTO _review;
  UPDATE public.calibration_adjustments
     SET decision='approved', decided_by=auth.uid(), decided_at=now(), applied_at=now(), updated_at=now()
   WHERE id = _adjustment_id
  RETURNING * INTO _adj;
  PERFORM set_config('talent.bypass_guard','off',true);

  _after := to_jsonb(_review);
  INSERT INTO public.talent_audit_log (organization_id, actor_user_id, action, entity_type, entity_id, before_state, after_state)
  VALUES (_adj.organization_id, auth.uid(), 'calibration.apply', 'performance_review', _review.id, _before, _after);

  RETURN _adj;
END;
$$;
REVOKE ALL ON FUNCTION public.talent_calibration_apply_adjustment(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.talent_calibration_apply_adjustment(uuid) TO authenticated;

-- 6. Extend talent_advance_cycle_phase to auto-create reviews on phase entry
CREATE OR REPLACE FUNCTION public.talent_advance_cycle_phase(_cycle_id uuid, _next_phase text)
RETURNS public.performance_cycles
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _cycle public.performance_cycles%ROWTYPE;
  _before jsonb; _after jsonb;
  _dummy integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  SELECT * INTO _cycle FROM public.performance_cycles WHERE id = _cycle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cycle % not found', _cycle_id USING ERRCODE = '02000'; END IF;
  IF NOT (public.has_role(auth.uid(), _cycle.organization_id, 'admin'::app_role)
          OR public.has_role(auth.uid(), _cycle.organization_id, 'owner'::app_role)) THEN
    RAISE EXCEPTION 'Only HR admins or owners may advance cycle phase' USING ERRCODE = '42501';
  END IF;
  IF _next_phase NOT IN ('draft','goal_setting','in_progress','self_review','manager_review','calibration','sign_off','closed') THEN
    RAISE EXCEPTION 'Invalid phase "%"', _next_phase USING ERRCODE = '22023';
  END IF;

  _before := to_jsonb(_cycle);
  PERFORM set_config('talent.bypass_guard','on',true);
  UPDATE public.performance_cycles SET phase=_next_phase, updated_at=now()
   WHERE id=_cycle_id RETURNING * INTO _cycle;
  PERFORM set_config('talent.bypass_guard','off',true);
  _after := to_jsonb(_cycle);

  INSERT INTO public.talent_audit_log (organization_id, actor_user_id, action, entity_type, entity_id, before_state, after_state)
  VALUES (_cycle.organization_id, auth.uid(), 'cycle.advance_phase', 'performance_cycle', _cycle.id, _before, _after);

  IF _next_phase = 'self_review' THEN
    SELECT created_count INTO _dummy FROM public.talent_bulk_create_reviews(_cycle_id, 'self');
  ELSIF _next_phase = 'manager_review' THEN
    SELECT created_count INTO _dummy FROM public.talent_bulk_create_reviews(_cycle_id, 'manager');
  END IF;

  RETURN _cycle;
END;
$$;
REVOKE ALL ON FUNCTION public.talent_advance_cycle_phase(uuid,text) FROM public;
GRANT EXECUTE ON FUNCTION public.talent_advance_cycle_phase(uuid,text) TO authenticated;
