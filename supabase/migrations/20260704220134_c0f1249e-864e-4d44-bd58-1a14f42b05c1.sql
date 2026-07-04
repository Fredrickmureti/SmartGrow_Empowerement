
-- =========================================================================
-- Talent Phase 1 — Audit-defensibility
-- =========================================================================

-- 1. Merit approve/reject/apply write to talent_audit_log
CREATE OR REPLACE FUNCTION public.talent_merit_approve(_ids uuid[])
RETURNS SETOF public.merit_recommendations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _row public.merit_recommendations;
  _before jsonb;
BEGIN
  FOR _row IN SELECT * FROM public.merit_recommendations WHERE id = ANY(_ids) LOOP
    IF NOT public.is_talent_admin(auth.uid(), _row.organization_id) THEN
      RAISE EXCEPTION 'Not authorized to approve merit %', _row.id;
    END IF;
    IF _row.status <> 'proposed' THEN
      RAISE EXCEPTION 'Merit % is not in proposed state (got %)', _row.id, _row.status;
    END IF;
    _before := to_jsonb(_row);
    UPDATE public.merit_recommendations
      SET status='approved', approved_by=auth.uid(), approved_at=now(), updated_at=now()
      WHERE id = _row.id
      RETURNING * INTO _row;
    INSERT INTO public.talent_audit_log
      (organization_id, actor_user_id, action, entity_type, entity_id, before_state, after_state)
    VALUES (_row.organization_id, auth.uid(), 'merit.approved', 'merit_recommendation', _row.id,
            _before, to_jsonb(_row));
    RETURN NEXT _row;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_merit_reject(_ids uuid[], _reason text)
RETURNS SETOF public.merit_recommendations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _row public.merit_recommendations;
  _before jsonb;
BEGIN
  FOR _row IN SELECT * FROM public.merit_recommendations WHERE id = ANY(_ids) LOOP
    IF NOT public.is_talent_admin(auth.uid(), _row.organization_id) THEN
      RAISE EXCEPTION 'Not authorized';
    END IF;
    IF _row.status NOT IN ('proposed','approved') THEN
      RAISE EXCEPTION 'Cannot reject from status %', _row.status;
    END IF;
    _before := to_jsonb(_row);
    UPDATE public.merit_recommendations
      SET status='rejected', rejected_by=auth.uid(), rejected_at=now(),
          rejection_reason=_reason, updated_at=now()
      WHERE id = _row.id
      RETURNING * INTO _row;
    INSERT INTO public.talent_audit_log
      (organization_id, actor_user_id, action, entity_type, entity_id, before_state, after_state, reason)
    VALUES (_row.organization_id, auth.uid(), 'merit.rejected', 'merit_recommendation', _row.id,
            _before, to_jsonb(_row), _reason);
    RETURN NEXT _row;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_merit_apply(_ids uuid[])
RETURNS SETOF public.merit_recommendations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _row public.merit_recommendations;
  _hist_id uuid;
  _before jsonb;
BEGIN
  FOR _row IN SELECT * FROM public.merit_recommendations WHERE id = ANY(_ids) LOOP
    IF NOT public.is_talent_admin(auth.uid(), _row.organization_id) THEN
      RAISE EXCEPTION 'Not authorized to apply merit %', _row.id;
    END IF;
    IF _row.status <> 'approved' THEN
      RAISE EXCEPTION 'Merit % must be approved before apply (got %)', _row.id, _row.status;
    END IF;
    _before := to_jsonb(_row);

    INSERT INTO public.employee_compensation_history (
      organization_id, business_id, employee_id, effective_date,
      basic_salary, allowances_json, currency_code, change_type, reason,
      approved_by, approved_at, submitted_by, submitted_at, created_by
    ) VALUES (
      _row.organization_id, _row.business_id, _row.employee_id, _row.effective_date,
      _row.new_salary, '{}'::jsonb, _row.currency_code,
      'merit_increase',
      COALESCE(_row.notes, 'Merit increase from performance cycle'),
      _row.approved_by, _row.approved_at, _row.proposed_by, _row.proposed_at, auth.uid()
    ) RETURNING id INTO _hist_id;

    UPDATE public.merit_recommendations
      SET status='applied', applied_by=auth.uid(), applied_at=now(),
          applied_history_id=_hist_id, updated_at=now()
      WHERE id = _row.id
      RETURNING * INTO _row;

    INSERT INTO public.talent_audit_log
      (organization_id, actor_user_id, action, entity_type, entity_id, before_state, after_state)
    VALUES (_row.organization_id, auth.uid(), 'merit.applied', 'merit_recommendation', _row.id,
            _before, to_jsonb(_row) || jsonb_build_object('compensation_history_id', _hist_id));
    RETURN NEXT _row;
  END LOOP;
END;
$$;

-- 2. 9-box placement — audit trail with previous placement
CREATE OR REPLACE FUNCTION public.talent_place_on_nine_box(
  _employee_id uuid,
  _cycle_id uuid,
  _potential smallint,
  _placement_reason text DEFAULT NULL,
  _performance_override smallint DEFAULT NULL
)
RETURNS public.talent_potential_ratings
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid;
  v_perf smallint;
  v_final numeric(3,2);
  v_row public.talent_potential_ratings;
  v_before jsonb;
BEGIN
  IF _potential IS NULL OR _potential < 1 OR _potential > 3 THEN
    RAISE EXCEPTION 'potential must be between 1 and 3';
  END IF;
  SELECT organization_id INTO v_org FROM public.performance_cycles WHERE id = _cycle_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'cycle not found'; END IF;
  IF NOT public.is_talent_admin(auth.uid(), v_org) THEN
    RAISE EXCEPTION 'forbidden: HR/admin role required';
  END IF;

  SELECT to_jsonb(t) INTO v_before
  FROM public.talent_potential_ratings t
  WHERE t.cycle_id = _cycle_id AND t.employee_id = _employee_id;

  SELECT pr.final_rating INTO v_final
  FROM public.performance_reviews pr
  WHERE pr.employee_id = _employee_id AND pr.cycle_id = _cycle_id AND pr.signed_off_at IS NOT NULL
  ORDER BY pr.signed_off_at DESC LIMIT 1;

  v_perf := COALESCE(_performance_override,
    CASE WHEN v_final IS NULL THEN 2
         WHEN v_final < 2.5 THEN 1
         WHEN v_final < 4.0 THEN 2
         ELSE 3 END);

  INSERT INTO public.talent_potential_ratings
    (organization_id, cycle_id, employee_id, potential, performance, placement_reason, placed_by)
  VALUES (v_org, _cycle_id, _employee_id, _potential, v_perf, _placement_reason, auth.uid())
  ON CONFLICT (cycle_id, employee_id) DO UPDATE
    SET potential=excluded.potential, performance=excluded.performance,
        placement_reason=excluded.placement_reason, placed_by=excluded.placed_by,
        placed_at=now()
  RETURNING * INTO v_row;

  INSERT INTO public.talent_audit_log
    (organization_id, actor_user_id, action, entity_type, entity_id, before_state, after_state)
  VALUES (v_org, auth.uid(),
          CASE WHEN v_before IS NULL THEN 'ninebox.placed' ELSE 'ninebox.moved' END,
          'talent_potential_rating', v_row.id, v_before, to_jsonb(v_row));

  RETURN v_row;
END;
$$;

-- 3. Server-authorized 9-box removal (replaces client-side DELETE)
CREATE OR REPLACE FUNCTION public.talent_remove_from_nine_box(_rating_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.talent_potential_ratings;
BEGIN
  SELECT * INTO v_row FROM public.talent_potential_ratings WHERE id = _rating_id;
  IF NOT FOUND THEN RAISE EXCEPTION '9-box rating not found'; END IF;
  IF NOT public.is_talent_admin(auth.uid(), v_row.organization_id) THEN
    RAISE EXCEPTION 'forbidden: HR/admin role required';
  END IF;
  DELETE FROM public.talent_potential_ratings WHERE id = _rating_id;
  INSERT INTO public.talent_audit_log
    (organization_id, actor_user_id, action, entity_type, entity_id, before_state)
  VALUES (v_row.organization_id, auth.uid(), 'ninebox.removed',
          'talent_potential_rating', v_row.id, to_jsonb(v_row));
END;
$$;
REVOKE ALL ON FUNCTION public.talent_remove_from_nine_box(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.talent_remove_from_nine_box(uuid) TO authenticated;

-- 4. Server-authorized calibration reject (replaces client-side UPDATE)
CREATE OR REPLACE FUNCTION public.talent_calibration_reject_adjustment(
  _adjustment_id uuid, _reason text DEFAULT NULL
)
RETURNS public.calibration_adjustments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.calibration_adjustments;
  v_before jsonb;
BEGIN
  SELECT * INTO v_row FROM public.calibration_adjustments WHERE id = _adjustment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'adjustment not found'; END IF;
  IF NOT public.is_talent_admin(auth.uid(), v_row.organization_id) THEN
    RAISE EXCEPTION 'forbidden: HR/admin role required';
  END IF;
  IF v_row.decision NOT IN ('pending','approved') THEN
    RAISE EXCEPTION 'Cannot reject adjustment from decision %', v_row.decision;
  END IF;
  v_before := to_jsonb(v_row);
  UPDATE public.calibration_adjustments
    SET decision='rejected', decided_by=auth.uid(), decided_at=now(), updated_at=now()
    WHERE id = _adjustment_id
    RETURNING * INTO v_row;
  INSERT INTO public.talent_audit_log
    (organization_id, actor_user_id, action, entity_type, entity_id, before_state, after_state, reason)
  VALUES (v_row.organization_id, auth.uid(), 'calibration.rejected',
          'calibration_adjustment', v_row.id, v_before, to_jsonb(v_row), _reason);
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.talent_calibration_reject_adjustment(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.talent_calibration_reject_adjustment(uuid, text) TO authenticated;

-- 5. Anonymous feedback privacy — scrub sender, retain admin-only copy
ALTER TABLE public.continuous_feedback
  ADD COLUMN IF NOT EXISTS from_user_id_admin uuid;

CREATE OR REPLACE FUNCTION public._talent_anon_feedback_scrub()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.is_anonymous IS TRUE AND NEW.from_user_id IS NOT NULL THEN
    NEW.from_user_id_admin := NEW.from_user_id;
    NEW.from_user_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS talent_anon_feedback_scrub ON public.continuous_feedback;
CREATE TRIGGER talent_anon_feedback_scrub
  BEFORE INSERT OR UPDATE ON public.continuous_feedback
  FOR EACH ROW EXECUTE FUNCTION public._talent_anon_feedback_scrub();

UPDATE public.continuous_feedback
   SET from_user_id_admin = from_user_id, from_user_id = NULL
 WHERE is_anonymous = true AND from_user_id IS NOT NULL;
