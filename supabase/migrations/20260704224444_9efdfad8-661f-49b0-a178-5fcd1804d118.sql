
-- =========================================================================
-- Talent Phase 2 (RPC-side notifications) + Phase 5 (skill uplift)
--   + succession/9-box lifecycle events + scheduled due-notification job
-- =========================================================================

-- 0. Add source column to competency_assessments
ALTER TABLE public.competency_assessments
  ADD COLUMN IF NOT EXISTS source text;
COMMENT ON COLUMN public.competency_assessments.source IS
  'Origin of the assessment level: self | manager | training | calibration';

-- ---------------------------------------------------------------------
-- 1. Notification helper (server-side): inserts a talent notification
--    from any RPC. Never raises — failures are swallowed so the primary
--    transition is not rolled back by a notification error.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._talent_notify(
  _org uuid,
  _biz uuid,
  _user_id uuid,
  _kind text,
  _title text,
  _message text,
  _link text,
  _entity_type text,
  _entity_id uuid,
  _priority int DEFAULT 3
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF _user_id IS NULL THEN RETURN; END IF;
  BEGIN
    INSERT INTO public.notifications
      (organization_id, business_id, user_id, type, category, title, message,
       link, entity_type, entity_id, priority)
    VALUES
      (_org, _biz, _user_id, 'info', 'talent', _title, _message,
       _link, _entity_type, _entity_id, COALESCE(_priority, 3));
  EXCEPTION WHEN OTHERS THEN
    -- Never let a notification failure roll back a business transition
    NULL;
  END;
END;
$$;
REVOKE ALL ON FUNCTION public._talent_notify(uuid,uuid,uuid,text,text,text,text,text,uuid,int) FROM PUBLIC;

-- ---------------------------------------------------------------------
-- 2. Extend talent_merit_apply to notify the affected employee
--    (keeps all Phase 3 downstream writes intact)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.talent_merit_apply(_ids uuid[])
RETURNS SETOF public.merit_recommendations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public'
AS $function$
DECLARE
  _row public.merit_recommendations;
  _hist_id uuid;
  _before jsonb;
  _contract public.employee_contracts;
  _amend_id uuid;
  _emp_user uuid;
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

    SELECT * INTO _contract
    FROM public.employee_contracts
    WHERE employee_id = _row.employee_id
      AND organization_id = _row.organization_id
      AND COALESCE(status, 'active') IN ('active','pending','draft')
      AND (end_date IS NULL OR end_date >= _row.effective_date)
    ORDER BY (status='active') DESC, start_date DESC NULLS LAST
    LIMIT 1;

    IF _contract.id IS NOT NULL THEN
      INSERT INTO public.contract_amendments (
        organization_id, business_id, contract_id, employee_id,
        kind, effective_on, actor_user_id, summary,
        before_snapshot, after_snapshot
      ) VALUES (
        _row.organization_id, _row.business_id, _contract.id, _row.employee_id,
        'salary_revision', _row.effective_date, auth.uid(),
        format('Merit increase %s%% (%s → %s)',
               round(_row.recommended_pct::numeric, 2),
               _row.current_salary, _row.new_salary),
        jsonb_build_object('wage', _contract.wage, 'currency_code', _row.currency_code),
        jsonb_build_object('wage', _row.new_salary, 'currency_code', _row.currency_code,
                           'merit_recommendation_id', _row.id,
                           'compensation_history_id', _hist_id)
      ) RETURNING id INTO _amend_id;
    END IF;

    INSERT INTO public.employee_lifecycle_events (
      organization_id, business_id, employee_id, event_type,
      occurred_at, effective_date, actor_user_id,
      source_table, source_id, summary, payload
    ) VALUES (
      _row.organization_id, _row.business_id, _row.employee_id, 'salary_revised',
      now(), _row.effective_date, auth.uid(),
      'merit_recommendations', _row.id,
      format('Salary revised via merit: %s → %s', _row.current_salary, _row.new_salary),
      jsonb_build_object(
        'merit_recommendation_id', _row.id,
        'compensation_history_id', _hist_id,
        'contract_amendment_id', _amend_id,
        'previous_salary', _row.current_salary,
        'new_salary', _row.new_salary,
        'pct', _row.recommended_pct
      )
    );

    UPDATE public.merit_recommendations
      SET status='applied', applied_by=auth.uid(), applied_at=now(),
          applied_history_id=_hist_id, updated_at=now()
      WHERE id = _row.id
      RETURNING * INTO _row;

    INSERT INTO public.talent_audit_log
      (organization_id, actor_user_id, action, entity_type, entity_id, before_state, after_state)
    VALUES (_row.organization_id, auth.uid(), 'merit.applied', 'merit_recommendation', _row.id,
            _before, to_jsonb(_row) || jsonb_build_object(
              'compensation_history_id', _hist_id,
              'contract_amendment_id', _amend_id));

    -- NEW: notify the affected employee
    SELECT user_id INTO _emp_user FROM public.v_employees_canonical WHERE id = _row.employee_id;
    PERFORM public._talent_notify(
      _row.organization_id, _row.business_id, _emp_user,
      'merit.applied',
      'Your compensation was updated',
      format('Your salary has been revised effective %s.', _row.effective_date),
      '/me/talent/compensation',
      'merit_recommendation', _row.id, 2);

    RETURN NEXT _row;
  END LOOP;
END;
$function$;

-- ---------------------------------------------------------------------
-- 3. Extend calibration apply to notify the reviewee's manager
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.talent_calibration_apply_adjustment(_adjustment_id uuid)
RETURNS public.calibration_adjustments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _adj public.calibration_adjustments%ROWTYPE;
  _review public.performance_reviews%ROWTYPE;
  _before jsonb; _after jsonb;
  _mgr_id uuid; _mgr_user uuid;
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

  -- NEW: notify the reviewee's manager
  SELECT manager_id INTO _mgr_id FROM public.v_employees_canonical WHERE id = _review.employee_id;
  IF _mgr_id IS NOT NULL THEN
    SELECT user_id INTO _mgr_user FROM public.v_employees_canonical WHERE id = _mgr_id;
    PERFORM public._talent_notify(
      _adj.organization_id, NULL, _mgr_user,
      'review.rating_calibrated',
      'A review rating was calibrated',
      format('A calibration adjustment changed one of your reports'' final rating to %s.', _adj.proposed_rating),
      format('/hr/talent/reviews/%s', _review.id),
      'performance_review', _review.id, 2);
  END IF;

  RETURN _adj;
END;
$$;

-- ---------------------------------------------------------------------
-- 4. Extend talent_place_on_nine_box: notify placed employee + emit
--    HiPo lifecycle event when placed in a high-potential/high-performance cell.
-- ---------------------------------------------------------------------
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
  v_emp_user uuid;
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

  -- NEW: HiPo lifecycle event when placed in top-right cell (potential=3 & performance=3)
  IF _potential = 3 AND v_perf = 3 THEN
    INSERT INTO public.employee_lifecycle_events (
      organization_id, employee_id, event_type, occurred_at,
      actor_user_id, source_table, source_id, summary, payload
    ) VALUES (
      v_org, _employee_id, 'custom', now(),
      auth.uid(), 'talent_potential_ratings', v_row.id,
      'HiPo designated on 9-box',
      jsonb_build_object('event_kind','hipo_designated',
                         'cycle_id', _cycle_id,
                         'potential', _potential,
                         'performance', v_perf)
    );
  END IF;

  -- NEW: notify the placed employee (silent transition previously)
  SELECT user_id INTO v_emp_user FROM public.v_employees_canonical WHERE id = _employee_id;
  PERFORM public._talent_notify(
    v_org, NULL, v_emp_user,
    'nine_box.placed',
    'You were placed on the talent grid',
    format('Your manager placed you on the talent 9-box (potential %s, performance %s).', _potential, v_perf),
    '/me/talent/dashboard',
    'talent_potential_rating', v_row.id, 3);

  RETURN v_row;
END;
$$;

-- ---------------------------------------------------------------------
-- 5. Extend talent_quiz_grade: upsert competency_assessments with
--    source='training' on pass; emit certification_earned lifecycle event
--    when the course requires a certificate.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.talent_quiz_grade(_attempt_id uuid, _answers jsonb)
RETURNS public.quiz_attempts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
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
  _emp_user uuid;
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
    IF _is_correct THEN _earned := _earned + _q.points; END IF;
  END LOOP;

  _final_score := CASE WHEN _total_points > 0 THEN ROUND((_earned / _total_points) * 100, 2) ELSE 0 END;
  _passed := _final_score >= _quiz.pass_score;

  UPDATE public.quiz_attempts
    SET answers=_answers, submitted_at=now(), score=_final_score, passed=_passed, updated_at=now()
    WHERE id = _attempt_id RETURNING * INTO _attempt;

  IF _passed THEN
    IF _attempt.enrollment_id IS NOT NULL THEN
      UPDATE public.training_enrollments
        SET status='completed',
            completed_at=COALESCE(completed_at, now()),
            score=GREATEST(COALESCE(score,0), _final_score),
            updated_at=now()
        WHERE id = _attempt.enrollment_id;
    END IF;

    IF _course.competency_ids IS NOT NULL AND _course.target_level IS NOT NULL THEN
      FOREACH _comp_id IN ARRAY _course.competency_ids LOOP
        -- Legacy employee_competencies uplift (unchanged)
        INSERT INTO public.employee_competencies (
          organization_id, employee_id, competency_id, level, assessed_at, assessor_user_id, notes
        ) VALUES (
          _attempt.organization_id, _attempt.employee_id, _comp_id, _course.target_level,
          CURRENT_DATE, auth.uid(),
          'Auto-awarded via quiz: ' || _quiz.title
        ) ON CONFLICT DO NOTHING;

        -- NEW: canonical competency_assessments upsert with source='training'
        INSERT INTO public.competency_assessments (
          organization_id, employee_id, competency_id,
          required_level, final_level, status, assessed_at, source
        ) VALUES (
          _attempt.organization_id, _attempt.employee_id, _comp_id,
          _course.target_level, _course.target_level, 'completed', now(), 'training'
        )
        ON CONFLICT (employee_id, competency_id) DO UPDATE
          SET final_level = GREATEST(EXCLUDED.final_level, public.competency_assessments.final_level),
              status = 'completed',
              assessed_at = now(),
              source = 'training',
              updated_at = now();
      END LOOP;
    END IF;

    -- NEW: certification earned lifecycle event
    IF COALESCE(_course.requires_certificate, false) THEN
      INSERT INTO public.employee_lifecycle_events (
        organization_id, employee_id, event_type, occurred_at,
        actor_user_id, source_table, source_id, summary, payload
      ) VALUES (
        _attempt.organization_id, _attempt.employee_id, 'custom', now(),
        auth.uid(), 'quiz_attempts', _attempt.id,
        format('Certification earned: %s', _course.name),
        jsonb_build_object('event_kind','certification_earned',
                           'course_id', _course.id,
                           'course_name', _course.name,
                           'quiz_id', _quiz.id,
                           'score', _final_score)
      );
    END IF;

    -- NEW: notify employee
    SELECT user_id INTO _emp_user FROM public.v_employees_canonical WHERE id = _attempt.employee_id;
    PERFORM public._talent_notify(
      _attempt.organization_id, NULL, _emp_user,
      'competency.uplifted',
      'You passed a quiz',
      format('You passed "%s" (score %s). Your competency level was updated.', _quiz.title, _final_score),
      '/me/talent/learning',
      'quiz_attempt', _attempt.id, 3);
  END IF;

  INSERT INTO public.talent_audit_log
    (organization_id, actor_user_id, action, entity_type, entity_id, after_state)
  VALUES (_attempt.organization_id, auth.uid(),
          CASE WHEN _passed THEN 'quiz.passed' ELSE 'quiz.graded' END,
          'quiz_attempt', _attempt.id, to_jsonb(_attempt));

  RETURN _attempt;
END;
$$;

-- Ensure the ON CONFLICT target above exists as a unique constraint.
-- If the table historically has no unique on (employee_id, competency_id),
-- add a partial index that acts as one (safe if already present).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='competency_assessments'
       AND indexname='competency_assessments_employee_competency_uk'
  ) THEN
    CREATE UNIQUE INDEX competency_assessments_employee_competency_uk
      ON public.competency_assessments (employee_id, competency_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6. talent_devplan_item_complete: mark a dev-plan item complete and
--    uplift its linked competency (source='training').
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.talent_devplan_item_complete(_item_id uuid)
RETURNS public.development_plan_items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _item public.development_plan_items;
  _plan RECORD;
  _course public.training_courses;
  _lvl smallint;
BEGIN
  SELECT * INTO _item FROM public.development_plan_items WHERE id = _item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item not found'; END IF;

  SELECT * INTO _plan FROM public.development_plans WHERE id = _item.plan_id;
  IF _plan IS NULL THEN RAISE EXCEPTION 'Parent plan not found'; END IF;

  IF _item.status = 'completed' THEN RETURN _item; END IF;

  UPDATE public.development_plan_items
    SET status='completed', progress_pct=100, completed_at=now(), updated_at=now()
    WHERE id = _item_id RETURNING * INTO _item;

  -- If linked to a training course + competency, uplift the assessment
  IF _item.competency_id IS NOT NULL THEN
    _lvl := 3; -- default intermediate; course-driven when present
    IF _item.training_course_id IS NOT NULL THEN
      SELECT * INTO _course FROM public.training_courses WHERE id = _item.training_course_id;
      IF _course.target_level IS NOT NULL THEN _lvl := _course.target_level; END IF;
    END IF;

    INSERT INTO public.competency_assessments (
      organization_id, employee_id, competency_id,
      required_level, final_level, status, assessed_at, source
    ) VALUES (
      _item.organization_id, _plan.employee_id, _item.competency_id,
      _lvl, _lvl, 'completed', now(), 'training'
    )
    ON CONFLICT (employee_id, competency_id) DO UPDATE
      SET final_level = GREATEST(EXCLUDED.final_level, public.competency_assessments.final_level),
          status='completed', source='training',
          assessed_at=now(), updated_at=now();
  END IF;

  INSERT INTO public.talent_audit_log
    (organization_id, actor_user_id, action, entity_type, entity_id, after_state)
  VALUES (_item.organization_id, auth.uid(), 'devplan.item_completed',
          'development_plan_item', _item.id, to_jsonb(_item));

  RETURN _item;
END;
$$;
REVOKE ALL ON FUNCTION public.talent_devplan_item_complete(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.talent_devplan_item_complete(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 7. Successors readiness → lifecycle event trigger
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._talent_successor_readiness_trg()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (TG_OP='UPDATE' AND NEW.readiness IS DISTINCT FROM OLD.readiness AND NEW.readiness = 'ready_now')
     OR (TG_OP='INSERT' AND NEW.readiness = 'ready_now') THEN
    INSERT INTO public.employee_lifecycle_events (
      organization_id, employee_id, event_type, occurred_at,
      source_table, source_id, summary, payload
    ) VALUES (
      NEW.organization_id, NEW.employee_id, 'custom', now(),
      'successors', NEW.id,
      'Successor is ready now',
      jsonb_build_object('event_kind','succession_ready','plan_id', NEW.plan_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_talent_successor_readiness ON public.successors;
CREATE TRIGGER trg_talent_successor_readiness
  AFTER INSERT OR UPDATE OF readiness ON public.successors
  FOR EACH ROW EXECUTE FUNCTION public._talent_successor_readiness_trg();

-- ---------------------------------------------------------------------
-- 8. Scheduled due notifications: goal check-in due + 1-on-1 reminders
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.talent_emit_due_notifications()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _n int := 0;
  _r RECORD;
BEGIN
  -- Goals: check-in due
  FOR _r IN
    SELECT g.id, g.title, g.organization_id, g.employee_id, e.user_id
    FROM public.performance_goals g
    JOIN public.v_employees_canonical e ON e.id = g.employee_id
    WHERE g.next_check_in_due_at IS NOT NULL
      AND g.next_check_in_due_at <= now()
      AND COALESCE(g.status::text,'') NOT IN ('done','cancelled','archived')
      AND e.user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.notifications n
        WHERE n.user_id = e.user_id
          AND n.entity_type = 'performance_goal'
          AND n.entity_id = g.id
          AND n.category = 'talent'
          AND n.title = 'Goal check-in due'
          AND n.created_at > now() - interval '20 hours'
      )
  LOOP
    PERFORM public._talent_notify(
      _r.organization_id, NULL, _r.user_id,
      'goal.checkin_due', 'Goal check-in due',
      format('Your goal "%s" is due for a check-in.', _r.title),
      format('/me/talent/goals/%s', _r.id),
      'performance_goal', _r.id, 3);
    _n := _n + 1;
  END LOOP;

  -- 1-on-1s: within next 24 hours
  FOR _r IN
    SELECT o.id, o.organization_id, o.scheduled_at,
           em.user_id AS emp_user, mm.user_id AS mgr_user
    FROM public.one_on_ones o
    JOIN public.v_employees_canonical em ON em.id = o.employee_id
    JOIN public.v_employees_canonical mm ON mm.id = o.manager_id
    WHERE o.scheduled_at BETWEEN now() AND now() + interval '24 hours'
      AND COALESCE(o.status, 'scheduled') = 'scheduled'
      AND NOT EXISTS (
        SELECT 1 FROM public.notifications n
        WHERE n.entity_type='one_on_one' AND n.entity_id = o.id
          AND n.category='talent' AND n.title='1-on-1 reminder'
          AND n.created_at > now() - interval '20 hours'
      )
  LOOP
    PERFORM public._talent_notify(_r.organization_id, NULL, _r.emp_user,
      'oneonone.reminder', '1-on-1 reminder',
      format('Your 1-on-1 is scheduled for %s.', to_char(_r.scheduled_at, 'YYYY-MM-DD HH24:MI')),
      '/me/talent/one-on-ones', 'one_on_one', _r.id, 3);
    PERFORM public._talent_notify(_r.organization_id, NULL, _r.mgr_user,
      'oneonone.reminder', '1-on-1 reminder',
      format('Your 1-on-1 is scheduled for %s.', to_char(_r.scheduled_at, 'YYYY-MM-DD HH24:MI')),
      '/hr/talent/one-on-ones', 'one_on_one', _r.id, 3);
    _n := _n + 2;
  END LOOP;

  RETURN _n;
END;
$$;
REVOKE ALL ON FUNCTION public.talent_emit_due_notifications() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.talent_emit_due_notifications() TO service_role;
