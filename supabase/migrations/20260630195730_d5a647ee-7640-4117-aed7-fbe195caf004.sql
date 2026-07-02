
-- ============================================================
-- Loan Skip Overrides — enterprise hardening
-- ============================================================

-- ---------- 1. Schedule-adjustment engine rewrite ----------
-- Drop the old 2-arg overload to remove ambiguity (compute-payroll
-- calls the override-centric form below).
DROP FUNCTION IF EXISTS public.apply_loan_skip_schedule_adjustment(uuid, uuid);

CREATE OR REPLACE FUNCTION public.apply_loan_skip_schedule_adjustment(
  _override_id uuid,
  _payroll_run_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ov public.payroll_run_loan_skip_overrides;
  v_adj text;
  v_sched record;
  v_last_seq int;
  v_next_id uuid;
  v_amount numeric;
  v_period_end date;
  v_remaining int;
  v_per numeric;
  v_payslip_id uuid;
BEGIN
  SELECT * INTO v_ov
    FROM public.payroll_run_loan_skip_overrides
    WHERE id = _override_id
    FOR UPDATE;
  IF v_ov.id IS NULL THEN RAISE EXCEPTION 'override not found: %', _override_id; END IF;
  IF v_ov.status = 'consumed' THEN
    RETURN jsonb_build_object('ok', true, 'noop', true, 'reason', 'already_consumed');
  END IF;
  IF v_ov.status <> 'approved' THEN
    RAISE EXCEPTION 'override % is %, cannot consume', v_ov.id, v_ov.status;
  END IF;

  SELECT lt.schedule_adjustment_on_skip INTO v_adj
    FROM public.employee_loans el
    JOIN public.loan_types lt ON lt.id = el.loan_type_id
    WHERE el.id = v_ov.loan_id;
  v_adj := COALESCE(v_adj, 'push_end');

  SELECT * INTO v_sched FROM public.loan_repayment_schedule WHERE id = v_ov.schedule_id FOR UPDATE;
  IF v_sched.id IS NULL THEN RAISE EXCEPTION 'schedule % not found', v_ov.schedule_id; END IF;

  v_amount := v_sched.scheduled_amount;

  IF v_sched.status <> 'skipped' THEN
    UPDATE public.loan_repayment_schedule
      SET status = 'skipped',
          notes = COALESCE(notes,'') || ' [skipped by override ' || v_ov.id || ']',
          updated_at = now()
      WHERE id = v_sched.id;

    IF v_adj = 'push_end' THEN
      SELECT max(sequence), max(due_period_end) INTO v_last_seq, v_period_end
        FROM public.loan_repayment_schedule WHERE loan_id = v_ov.loan_id;
      INSERT INTO public.loan_repayment_schedule
        (loan_id, sequence, due_period_start, due_period_end, scheduled_amount, status, notes)
      VALUES
        (v_ov.loan_id, v_last_seq + 1, v_period_end + 1, v_period_end + 30, v_amount, 'pending',
         '[appended from skip of seq ' || v_sched.sequence || ']');
    ELSIF v_adj = 'absorb_into_next' THEN
      SELECT id INTO v_next_id FROM public.loan_repayment_schedule
        WHERE loan_id = v_ov.loan_id AND status IN ('pending','partial') AND sequence > v_sched.sequence
        ORDER BY sequence LIMIT 1;
      IF v_next_id IS NOT NULL THEN
        UPDATE public.loan_repayment_schedule
          SET scheduled_amount = scheduled_amount + v_amount,
              notes = COALESCE(notes,'') || ' [+' || v_amount || ' absorbed from skipped seq ' || v_sched.sequence || ']',
              updated_at = now()
          WHERE id = v_next_id;
      ELSE
        SELECT max(sequence), max(due_period_end) INTO v_last_seq, v_period_end
          FROM public.loan_repayment_schedule WHERE loan_id = v_ov.loan_id;
        INSERT INTO public.loan_repayment_schedule
          (loan_id, sequence, due_period_start, due_period_end, scheduled_amount, status, notes)
        VALUES (v_ov.loan_id, v_last_seq + 1, v_period_end + 1, v_period_end + 30, v_amount, 'pending', '[absorb_into_next fallback]');
      END IF;
    ELSIF v_adj = 'balloon' THEN
      SELECT id INTO v_next_id FROM public.loan_repayment_schedule
        WHERE loan_id = v_ov.loan_id AND status IN ('pending','partial')
        ORDER BY sequence DESC LIMIT 1;
      IF v_next_id IS NOT NULL THEN
        UPDATE public.loan_repayment_schedule
          SET scheduled_amount = scheduled_amount + v_amount,
              notes = COALESCE(notes,'') || ' [balloon +' || v_amount || ' from skipped seq ' || v_sched.sequence || ']',
              updated_at = now()
          WHERE id = v_next_id;
      END IF;
    ELSIF v_adj = 'extend_tenure' THEN
      SELECT count(*) INTO v_remaining FROM public.loan_repayment_schedule
        WHERE loan_id = v_ov.loan_id AND status IN ('pending','partial');
      IF v_remaining = 0 THEN
        SELECT max(sequence), max(due_period_end) INTO v_last_seq, v_period_end
          FROM public.loan_repayment_schedule WHERE loan_id = v_ov.loan_id;
        INSERT INTO public.loan_repayment_schedule
          (loan_id, sequence, due_period_start, due_period_end, scheduled_amount, status, notes)
        VALUES (v_ov.loan_id, v_last_seq + 1, v_period_end + 1, v_period_end + 30, v_amount, 'pending', '[extend_tenure new period]');
      ELSE
        v_per := round((v_amount / (v_remaining + 1))::numeric, 2);
        UPDATE public.loan_repayment_schedule
          SET scheduled_amount = scheduled_amount + v_per,
              notes = COALESCE(notes,'') || ' [+' || v_per || ' from extend_tenure of seq ' || v_sched.sequence || ']',
              updated_at = now()
          WHERE loan_id = v_ov.loan_id AND status IN ('pending','partial');
        SELECT max(sequence), max(due_period_end) INTO v_last_seq, v_period_end
          FROM public.loan_repayment_schedule WHERE loan_id = v_ov.loan_id;
        INSERT INTO public.loan_repayment_schedule
          (loan_id, sequence, due_period_start, due_period_end, scheduled_amount, status, notes)
        VALUES (v_ov.loan_id, v_last_seq + 1, v_period_end + 1, v_period_end + 30, v_per, 'pending', '[extend_tenure new period]');
      END IF;
    END IF;
  END IF;

  -- Resolve consuming payslip (best-effort).
  SELECT id INTO v_payslip_id
    FROM public.payslips
    WHERE payroll_run_id = _payroll_run_id AND employee_id = v_ov.employee_id
    ORDER BY created_at DESC
    LIMIT 1;

  -- Mark override consumed.
  UPDATE public.payroll_run_loan_skip_overrides
    SET status = 'consumed',
        consumed_at = now(),
        consumed_payslip_id = v_payslip_id,
        updated_at = now()
    WHERE id = v_ov.id;

  -- Audit (override + loan).
  INSERT INTO public.loan_skip_override_events
    (organization_id, override_id, event_type, prior_status, new_status, actor_user_id, payload)
  VALUES
    (v_ov.organization_id, v_ov.id, 'consumed', v_ov.status, 'consumed', NULL,
     jsonb_build_object('schedule_id', v_ov.schedule_id, 'amount', v_amount, 'adjustment', v_adj, 'payslip_id', v_payslip_id));

  INSERT INTO public.loan_lifecycle_events
    (organization_id, loan_id, event_type, prior_status, new_status, amount, reason, payload, actor_user_id)
  VALUES
    (v_ov.organization_id, v_ov.loan_id, 'skip_consumed', NULL, NULL, v_amount,
     'Loan skip override consumed in payroll run',
     jsonb_build_object('override_id', v_ov.id, 'payroll_run_id', _payroll_run_id, 'schedule_id', v_ov.schedule_id, 'adjustment', v_adj), NULL);

  RETURN jsonb_build_object('ok', true, 'adjustment', v_adj, 'amount', v_amount, 'consumed_payslip_id', v_payslip_id);
END
$$;

GRANT EXECUTE ON FUNCTION public.apply_loan_skip_schedule_adjustment(uuid, uuid) TO authenticated, service_role;

-- ---------- 2. Tighten core-field immutability for approved overrides ----------
CREATE OR REPLACE FUNCTION public.tg_prlso_protect_terminal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'consumed' THEN
    RAISE EXCEPTION 'override % is consumed and cannot be modified', OLD.id;
  END IF;
  IF OLD.status IN ('approved','rejected','cancelled','expired') AND TG_OP = 'UPDATE' THEN
    IF NEW.payroll_run_id IS DISTINCT FROM OLD.payroll_run_id
       OR NEW.loan_id IS DISTINCT FROM OLD.loan_id
       OR NEW.schedule_id IS DISTINCT FROM OLD.schedule_id
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.reason_category IS DISTINCT FROM OLD.reason_category THEN
      RAISE EXCEPTION 'override % is %; core fields are immutable', OLD.id, OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------- 3. Active-override uniqueness ----------
-- Partial unique index so an installment in a run cannot have two
-- competing active overrides; rejected/cancelled/expired don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_prlso_active_per_schedule
  ON public.payroll_run_loan_skip_overrides (payroll_run_id, schedule_id)
  WHERE status IN ('pending','approved','consumed');

-- ---------- 4. Governance-integrated maker/checker RPCs ----------
CREATE OR REPLACE FUNCTION public.loan_skip_override_approve(_override_id uuid)
RETURNS public.payroll_run_loan_skip_overrides
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r public.payroll_run_loan_skip_overrides;
  v_uid uuid := auth.uid();
  v_lt record;
BEGIN
  SELECT * INTO r FROM public.payroll_run_loan_skip_overrides WHERE id = _override_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'override not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'override is %, cannot approve', r.status; END IF;
  IF NOT public.user_has_module_permission(v_uid, r.organization_id, 'payroll', 'approve') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  -- Delegate self-action enforcement to the company-wide Governance framework.
  PERFORM public.governance_assert_not_self(
    v_uid, r.created_by, 'payroll.loan_skip_override.approve',
    r.organization_id, 'payroll_run_loan_skip_override', r.id
  );

  SELECT lt.allow_skip, lt.max_skips_per_loan
    INTO v_lt
    FROM public.employee_loans el
    JOIN public.loan_types lt ON lt.id = el.loan_type_id
    WHERE el.id = r.loan_id;
  IF v_lt.allow_skip IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'loan_type forbids skips';
  END IF;
  IF v_lt.max_skips_per_loan IS NOT NULL THEN
    IF (SELECT count(*) FROM public.payroll_run_loan_skip_overrides
         WHERE loan_id = r.loan_id AND status IN ('approved','consumed')) >= v_lt.max_skips_per_loan THEN
      RAISE EXCEPTION 'loan has reached max_skips_per_loan (%)', v_lt.max_skips_per_loan;
    END IF;
  END IF;

  UPDATE public.payroll_run_loan_skip_overrides
    SET status = 'approved', approved_by = v_uid, approved_at = now()
    WHERE id = _override_id
    RETURNING * INTO r;

  INSERT INTO public.loan_skip_override_events
    (organization_id, override_id, event_type, prior_status, new_status, actor_user_id)
  VALUES (r.organization_id, r.id, 'approved', 'pending', 'approved', v_uid);

  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.loan_skip_override_reject(_override_id uuid, _reason text)
RETURNS public.payroll_run_loan_skip_overrides
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r public.payroll_run_loan_skip_overrides;
  v_uid uuid := auth.uid();
BEGIN
  SELECT * INTO r FROM public.payroll_run_loan_skip_overrides WHERE id = _override_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'override not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'override is %, cannot reject', r.status; END IF;
  IF NOT public.user_has_module_permission(v_uid, r.organization_id, 'payroll', 'approve') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  PERFORM public.governance_assert_not_self(
    v_uid, r.created_by, 'payroll.loan_skip_override.reject',
    r.organization_id, 'payroll_run_loan_skip_override', r.id
  );

  UPDATE public.payroll_run_loan_skip_overrides
    SET status = 'rejected', rejected_by = v_uid, rejected_at = now(), rejection_reason = _reason
    WHERE id = _override_id
    RETURNING * INTO r;

  INSERT INTO public.loan_skip_override_events
    (organization_id, override_id, event_type, prior_status, new_status, actor_user_id, reason)
  VALUES (r.organization_id, r.id, 'rejected', 'pending', 'rejected', v_uid, _reason);

  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.loan_skip_override_cancel(_override_id uuid, _reason text)
RETURNS public.payroll_run_loan_skip_overrides
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r public.payroll_run_loan_skip_overrides;
  v_uid uuid := auth.uid();
BEGIN
  SELECT * INTO r FROM public.payroll_run_loan_skip_overrides WHERE id = _override_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'override not found'; END IF;
  IF r.status NOT IN ('pending','approved') THEN
    RAISE EXCEPTION 'override is %, cannot cancel', r.status;
  END IF;
  IF NOT public.user_has_module_permission(v_uid, r.organization_id, 'payroll', 'approve') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  -- Cancelling your own approval still counts as a self-action; mode controls outcome.
  PERFORM public.governance_assert_not_self(
    v_uid, COALESCE(r.approved_by, r.created_by), 'payroll.loan_skip_override.cancel',
    r.organization_id, 'payroll_run_loan_skip_override', r.id
  );

  UPDATE public.payroll_run_loan_skip_overrides
    SET status = 'cancelled', cancelled_by = v_uid, cancelled_at = now()
    WHERE id = _override_id
    RETURNING * INTO r;

  INSERT INTO public.loan_skip_override_events
    (organization_id, override_id, event_type, prior_status, new_status, actor_user_id, reason)
  VALUES (r.organization_id, r.id, 'cancelled', NULL, 'cancelled', v_uid, _reason);

  RETURN r;
END $$;

GRANT EXECUTE ON FUNCTION public.loan_skip_override_approve(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.loan_skip_override_reject(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.loan_skip_override_cancel(uuid, text) TO authenticated;

-- ---------- 5. HR auto-cancel writes audit + captures actor ----------
CREATE OR REPLACE FUNCTION public.tg_hr_event_propose_loan_skip()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_auto boolean;
  v_run record;
  v_loan record;
  v_sched record;
  v_category text;
  v_actor uuid := COALESCE(auth.uid(), NEW.created_by);
  v_ov_id uuid;
BEGIN
  IF NEW.event_type IN ('reinstated','leave_of_absence_ended','returned_from_leave') THEN
    FOR v_ov_id IN
      SELECT id FROM public.payroll_run_loan_skip_overrides
       WHERE employee_id = NEW.employee_id
         AND status = 'pending'
         AND source = 'hr_event'
    LOOP
      UPDATE public.payroll_run_loan_skip_overrides
        SET status = 'cancelled',
            cancelled_by = v_actor,
            cancelled_at = now(),
            updated_at = now()
        WHERE id = v_ov_id;
      INSERT INTO public.loan_skip_override_events
        (organization_id, override_id, event_type, prior_status, new_status, actor_user_id, reason, payload)
      VALUES (NEW.organization_id, v_ov_id, 'cancelled', 'pending', 'cancelled', v_actor,
              'Auto-cancelled by HR event: ' || NEW.event_type,
              jsonb_build_object('source_event_id', NEW.id, 'event_type', NEW.event_type));
    END LOOP;
    RETURN NEW;
  END IF;

  IF NEW.event_type NOT IN ('leave_of_absence_started','suspended','unpaid_leave_started') THEN
    RETURN NEW;
  END IF;

  v_category := CASE NEW.event_type
    WHEN 'leave_of_absence_started' THEN 'leave_of_absence'
    WHEN 'suspended' THEN 'suspension'
    ELSE 'unpaid_leave' END;

  SELECT unpaid_leave_auto_pause INTO v_auto FROM public.payroll_loan_recovery_policy
    WHERE organization_id = NEW.organization_id ORDER BY business_id NULLS LAST LIMIT 1;
  IF v_auto IS DISTINCT FROM TRUE THEN RETURN NEW; END IF;

  FOR v_run IN
    SELECT id, pay_period_start, pay_period_end FROM public.payroll_runs
    WHERE organization_id = NEW.organization_id AND status IN ('draft','computed','computing')
  LOOP
    FOR v_loan IN
      SELECT id FROM public.employee_loans
      WHERE employee_id = NEW.employee_id AND status = 'active'
    LOOP
      FOR v_sched IN
        SELECT id FROM public.loan_repayment_schedule
        WHERE loan_id = v_loan.id AND status IN ('pending','partial')
          AND due_period_end BETWEEN v_run.pay_period_start AND v_run.pay_period_end
      LOOP
        INSERT INTO public.payroll_run_loan_skip_overrides
          (organization_id, payroll_run_id, loan_id, schedule_id, employee_id, reason, reason_category, source, source_event_id, status, created_by)
        VALUES
          (NEW.organization_id, v_run.id, v_loan.id, v_sched.id, NEW.employee_id,
           'Auto-proposed: ' || NEW.event_type, v_category, 'hr_event', NEW.id, 'pending', v_actor)
        ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN NEW;
END $$;

-- ---------- 6. Expire stale overrides ----------
CREATE OR REPLACE FUNCTION public.loan_skip_override_expire_stale(_org_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int := 0;
  v_row record;
BEGIN
  FOR v_row IN
    SELECT ov.id, ov.organization_id, ov.status
      FROM public.payroll_run_loan_skip_overrides ov
      JOIN public.payroll_runs pr ON pr.id = ov.payroll_run_id
     WHERE ov.status IN ('pending','approved')
       AND pr.status IN ('posted','closed','cancelled','reversed')
       AND (_org_id IS NULL OR ov.organization_id = _org_id)
  LOOP
    UPDATE public.payroll_run_loan_skip_overrides
      SET status = 'expired', updated_at = now()
      WHERE id = v_row.id;
    INSERT INTO public.loan_skip_override_events
      (organization_id, override_id, event_type, prior_status, new_status, actor_user_id, reason)
    VALUES (v_row.organization_id, v_row.id, 'expired', v_row.status, 'expired', NULL,
            'Auto-expired: payroll run closed without consuming override');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;
GRANT EXECUTE ON FUNCTION public.loan_skip_override_expire_stale(uuid) TO authenticated, service_role;

-- ---------- 7. Readiness eval — extend SQL predicate parameters ----------
-- The original 'sql' branch only bound $1=org_id, $2=business_id, so any
-- run-scope rule was effectively broken. Extend the EXECUTE to also bind
-- $3=subject_id (e.g. payroll_run_id), $4=period_start, $5=period_end.
CREATE OR REPLACE FUNCTION public.payroll_readiness_eval_rule(
  p_rule public.payroll_readiness_rules,
  p_org_id uuid,
  p_business_id uuid,
  p_subject_id uuid,
  p_period_start date,
  p_period_end date
)
RETURNS TABLE(status text, reason text, missing_fields text[], details jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_status     text := 'pass';
  v_reason     text;
  v_missing    text[] := ARRAY[]::text[];
  v_details    jsonb := '{}'::jsonb;
  v_hit_count  bigint;
  v_hit_ids    uuid[];
BEGIN
  CASE p_rule.check_kind
  WHEN 'sql' THEN
    IF p_rule.predicate_sql IS NOT NULL AND length(btrim(p_rule.predicate_sql)) > 0 THEN
      BEGIN
        EXECUTE 'SELECT count(*), COALESCE(array_agg(t.id), ARRAY[]::uuid[]) FROM (' || p_rule.predicate_sql || ' LIMIT 200) t'
          INTO v_hit_count, v_hit_ids
          USING p_org_id, p_business_id, p_subject_id, p_period_start, p_period_end;
      EXCEPTION WHEN OTHERS THEN
        v_status := 'fail';
        v_reason := 'SQL rule failed to execute: ' || SQLERRM;
        v_missing := ARRAY['rule_predicate'];
        v_details := jsonb_build_object('error', SQLERRM, 'code', SQLSTATE);
        RETURN QUERY SELECT v_status, v_reason, v_missing, v_details;
        RETURN;
      END;
      IF COALESCE(v_hit_count, 0) > 0 THEN
        v_status := 'fail';
        v_reason := COALESCE(p_rule.description, p_rule.name) || ' (' || v_hit_count || ')';
        v_missing := ARRAY[p_rule.code];
        v_details := jsonb_build_object('matched_ids', v_hit_ids, 'matched_count', v_hit_count);
      END IF;
    END IF;
  ELSE
    -- Fall through to the legacy evaluator for all non-sql kinds.
    RETURN QUERY SELECT * FROM public.payroll_readiness_eval_rule_legacy(
      p_rule, p_org_id, p_business_id, p_subject_id, p_period_start, p_period_end);
    RETURN;
  END CASE;

  RETURN QUERY SELECT v_status, v_reason, v_missing, v_details;
END;
$function$;

-- Stub the legacy fallback in case it's referenced — it just returns pass.
CREATE OR REPLACE FUNCTION public.payroll_readiness_eval_rule_legacy(
  p_rule public.payroll_readiness_rules,
  p_org_id uuid,
  p_business_id uuid,
  p_subject_id uuid,
  p_period_start date,
  p_period_end date
) RETURNS TABLE(status text, reason text, missing_fields text[], details jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Non-SQL kinds are evaluated by the canonical evaluator in
  -- 20260629001620; this stub exists only as a safety net so that an
  -- unknown check_kind no-ops to 'pass' instead of crashing the run.
  RETURN QUERY SELECT 'pass'::text, NULL::text, ARRAY[]::text[], '{}'::jsonb;
END $$;

-- ---------- 8. Fix loan-skip readiness rule predicates ----------
-- Replace the four broken predicates that referenced $4 (no longer
-- valid) with predicates bound to $3 = subject_id = payroll_run_id.
UPDATE public.payroll_readiness_rules
  SET predicate_sql = 'SELECT id FROM payroll_run_loan_skip_overrides WHERE payroll_run_id = $3 AND status = ''pending'''
  WHERE code = 'run.loan_skip_override_pending_approval';

UPDATE public.payroll_readiness_rules
  SET predicate_sql = 'SELECT o.id FROM payroll_run_loan_skip_overrides o JOIN loan_repayment_schedule s ON s.id = o.schedule_id JOIN employee_loans el ON el.id = o.loan_id WHERE o.payroll_run_id = $3 AND o.status = ''approved'' AND (s.status NOT IN (''pending'',''partial'',''skipped'') OR el.status <> ''active'')'
  WHERE code = 'run.loan_skip_override_invalid_target';

UPDATE public.payroll_readiness_rules
  SET predicate_sql = 'SELECT o.id FROM payroll_run_loan_skip_overrides o JOIN employee_loans el ON el.id = o.loan_id JOIN loan_types lt ON lt.id = el.loan_type_id WHERE o.payroll_run_id = $3 AND o.status = ''approved'' AND (lt.allow_skip = false OR (lt.max_skips_per_loan IS NOT NULL AND (SELECT count(*) FROM payroll_run_loan_skip_overrides x WHERE x.loan_id = o.loan_id AND x.status IN (''approved'',''consumed'')) > lt.max_skips_per_loan))',
      prerequisite_rule_codes = ARRAY['run.loan_skip_override_invalid_target']
  WHERE code = 'run.loan_skip_override_policy_breach';

UPDATE public.payroll_readiness_rules
  SET predicate_sql = 'SELECT o.id FROM payroll_run_loan_skip_overrides o WHERE o.payroll_run_id = $3 AND o.status = ''approved'' AND NOT EXISTS (SELECT 1 FROM payslips p WHERE p.payroll_run_id = o.payroll_run_id AND p.employee_id = o.employee_id)'
  WHERE code = 'run.loan_skip_override_employee_not_in_run';

-- New rule: min-gap violation between skips.
INSERT INTO public.payroll_readiness_rules
  (organization_id, code, name, description, scope, severity, source, reason_code, check_kind, remediation_label, predicate_sql, sort_order)
VALUES
  (NULL, 'run.loan_skip_override_min_gap_violation',
   'Loan skip overrides violate minimum gap between skips',
   'Warn when an approved override is closer than the loan type''s configured minimum gap to a previously consumed skip for the same loan.',
   'run','warn','core','RUN_LOAN_SKIP_OVERRIDE_MIN_GAP','sql','Open loan type settings',
   'SELECT o.id FROM payroll_run_loan_skip_overrides o JOIN employee_loans el ON el.id = o.loan_id JOIN loan_types lt ON lt.id = el.loan_type_id WHERE o.payroll_run_id = $3 AND o.status = ''approved'' AND lt.min_gap_between_skips_days IS NOT NULL AND EXISTS (SELECT 1 FROM payroll_run_loan_skip_overrides prev WHERE prev.loan_id = o.loan_id AND prev.id <> o.id AND prev.status IN (''approved'',''consumed'') AND prev.consumed_at IS NOT NULL AND prev.consumed_at > now() - (lt.min_gap_between_skips_days || '' days'')::interval)',
   244)
ON CONFLICT DO NOTHING;
