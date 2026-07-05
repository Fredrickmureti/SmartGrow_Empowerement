-- Fix: tg_hr_event_propose_loan_skip references phantom enum values
-- ('returned_from_leave', 'unpaid_leave_started') that are not members of
-- public.employee_lifecycle_event_type. Postgres coerces IN-list literals
-- against the enum column at plan time, so every insert into
-- employee_lifecycle_events failed with:
--   invalid input value for enum employee_lifecycle_event_type: "returned_from_leave"
-- which cascaded into every HR write that emits a lifecycle event
-- (contract create/activate/renew/amend/expire, hire, terminate,
--  leave start/end, reinstate, onboarding, salary revision, ...).
--
-- Canonical enum already models these concepts via 'leave_of_absence_ended'
-- and 'leave_of_absence_started'. Paid vs unpaid is a leave_requests /
-- payslip-input concern, not a lifecycle-vocabulary concern.

CREATE OR REPLACE FUNCTION public.tg_hr_event_propose_loan_skip()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_auto boolean;
  v_run record;
  v_loan record;
  v_sched record;
  v_category text;
  v_actor uuid := COALESCE(auth.uid(), NEW.actor_user_id);
  v_ov_id uuid;
BEGIN
  -- Cancel pending HR-sourced skip overrides when the employee returns
  -- from leave or is reinstated from suspension.
  IF NEW.event_type IN ('reinstated','leave_of_absence_ended') THEN
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

  -- Only propose skips for leave-of-absence start or suspension.
  IF NEW.event_type NOT IN ('leave_of_absence_started','suspended') THEN
    RETURN NEW;
  END IF;

  v_category := CASE NEW.event_type
    WHEN 'leave_of_absence_started' THEN 'leave_of_absence'
    WHEN 'suspended' THEN 'suspension'
    ELSE 'leave_of_absence' END;

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
END $function$;
