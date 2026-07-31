-- Wave G3 (part 2) — remaining DELETE-firing guards must honour teardown context.

CREATE OR REPLACE FUNCTION public.payroll_periods_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_locked_count integer;
BEGIN
  IF public._is_teardown_active() THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT count(*) INTO v_locked_count
    FROM payroll_runs pr
   WHERE pr.business_id = OLD.business_id
     AND pr.status IN ('posted','approved','paid','reversed')
     AND pr.pay_period_start <= OLD.end_date
     AND pr.pay_period_end   >= OLD.start_date;
  IF v_locked_count > 0 THEN
    RAISE EXCEPTION
      'PAYROLL_PERIOD_LOCKED: cannot % period % (% → %) — % posted/approved/paid payroll run(s) exist for this period',
      TG_OP, OLD.period_number, OLD.start_date, OLD.end_date, v_locked_count
      USING ERRCODE = '23P01';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.trg_guard_payroll_runs_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _biz uuid; _from date; _to date;
BEGIN
  IF public._is_teardown_active() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF current_setting('app.period_rpc', true) = 'payroll_period_transition' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    _biz := OLD.business_id; _from := OLD.pay_period_start; _to := OLD.pay_period_end;
  ELSE
    _biz := NEW.business_id; _from := NEW.pay_period_start; _to := NEW.pay_period_end;
  END IF;
  IF _biz IS NOT NULL AND _from IS NOT NULL AND _to IS NOT NULL
     AND public.payroll_period_frozen(_biz, _from, _to) THEN
    RAISE EXCEPTION 'payroll_runs write blocked: parent payroll period is closed/archived (business=%, window=% to %)',
      _biz, _from, _to USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $function$;

CREATE OR REPLACE FUNCTION public.trg_guard_payroll_return_runs_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _biz uuid; _from date; _to date;
BEGIN
  IF public._is_teardown_active() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF current_setting('app.period_rpc', true) = 'payroll_period_transition' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    _biz := OLD.business_id; _from := OLD.period_start; _to := OLD.period_end;
  ELSE
    _biz := NEW.business_id; _from := NEW.period_start; _to := NEW.period_end;
  END IF;
  IF _biz IS NOT NULL AND _from IS NOT NULL AND _to IS NOT NULL
     AND public.payroll_period_frozen(_biz, _from, _to) THEN
    RAISE EXCEPTION 'payroll_return_runs write blocked: parent payroll period is closed/archived (business=%, window=% to %)',
      _biz, _from, _to USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $function$;

CREATE OR REPLACE FUNCTION public.trg_guard_payroll_bank_export_files_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _biz uuid; _from date; _to date; _batch_id uuid;
BEGIN
  IF public._is_teardown_active() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF current_setting('app.period_rpc', true) = 'payroll_period_transition' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  _batch_id := COALESCE(NEW.batch_id, OLD.batch_id);
  _biz := COALESCE(NEW.business_id, OLD.business_id);
  SELECT r.pay_period_start, r.pay_period_end INTO _from, _to
  FROM public.payroll_payment_batches b
  JOIN public.payroll_runs r ON r.id = b.payroll_run_id
  WHERE b.id = _batch_id;
  IF _biz IS NOT NULL AND _from IS NOT NULL AND _to IS NOT NULL
     AND public.payroll_period_frozen(_biz, _from, _to) THEN
    RAISE EXCEPTION 'payroll_bank_export_files write blocked: parent payroll period is closed/archived (business=%, window=% to %)',
      _biz, _from, _to USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $function$;

CREATE OR REPLACE FUNCTION public.tg_prlso_no_destructive_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF public._is_teardown_active() THEN RETURN OLD; END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'override % is %; cancel via RPC instead of deleting', OLD.id, OLD.status;
  END IF;
  RETURN OLD;
END $function$;

CREATE OR REPLACE FUNCTION public.tg_prlso_protect_terminal()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF public._is_teardown_active() THEN RETURN COALESCE(NEW, OLD); END IF;
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
END $function$;

CREATE OR REPLACE FUNCTION public.salary_components_freeze_when_used()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_structure_id uuid := COALESCE(NEW.structure_id, OLD.structure_id);
  v_has_published boolean;
BEGIN
  IF public._is_teardown_active() THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT EXISTS(
    SELECT 1 FROM public.salary_structure_rule_sets
     WHERE structure_id = v_structure_id
       AND status IN ('active','superseded')
  ) INTO v_has_published;
  IF v_has_published THEN
    RAISE EXCEPTION
      'salary structure has published rule sets — direct component edits are forbidden'
      USING HINT = 'Editing components after publish would silently change historical payslip computations. Create a new structure or fork the rule set instead.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $function$;

CREATE OR REPLACE FUNCTION public.assert_no_branch_context_for_period_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_branch text; v_is_hq boolean;
BEGIN
  IF public._is_teardown_active() THEN RETURN COALESCE(NEW, OLD); END IF;
  v_branch := current_setting('app.active_branch_id', true);
  IF v_branch IS NULL OR v_branch = '' OR v_branch = 'null' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT COALESCE(is_headquarters, false) INTO v_is_hq
  FROM public.branches WHERE id = v_branch::uuid;
  IF COALESCE(v_is_hq, false) THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION
    'Fiscal period changes are managed at the parent business. Switch to the headquarters branch first.'
    USING ERRCODE = '42501';
END; $function$;

CREATE OR REPLACE FUNCTION public.check_payment_allocation_sum()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE v_pid uuid; v_sum numeric; v_applied numeric; v_status text;
BEGIN
  IF public._is_teardown_active() THEN RETURN NULL; END IF;
  v_pid := COALESCE(NEW.payment_id, OLD.payment_id);
  SELECT COALESCE(SUM(amount), 0) INTO v_sum
    FROM public.payment_allocations WHERE payment_id = v_pid;
  SELECT COALESCE(applied_amount, 0), COALESCE(status, 'completed')
    INTO v_applied, v_status
    FROM public.payments WHERE id = v_pid;
  IF v_status IN ('voided','cancelled','unreconciled') THEN RETURN NULL; END IF;
  IF ABS(v_sum - v_applied) > 0.005 THEN
    RAISE EXCEPTION 'Payment % allocation sum % does not match applied amount %.',
      v_pid, v_sum, v_applied USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.check_bill_payment_allocation_sum()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE v_bpid uuid; v_sum numeric; v_amount numeric;
BEGIN
  IF public._is_teardown_active() THEN RETURN NULL; END IF;
  v_bpid := COALESCE(NEW.bill_payment_id, OLD.bill_payment_id);
  SELECT COALESCE(SUM(amount), 0) INTO v_sum
    FROM public.bill_payment_allocations WHERE bill_payment_id = v_bpid;
  SELECT COALESCE(amount, 0) INTO v_amount
    FROM public.bill_payments WHERE id = v_bpid;
  IF v_sum > v_amount + 0.005 THEN
    RAISE EXCEPTION 'Bill payment % allocation sum % exceeds payment amount %.',
      v_bpid, v_sum, v_amount USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public._pc_immutable_after_post()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF public._is_teardown_active() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF OLD.state IN ('posted','cancelled','superseded') AND TG_OP = 'UPDATE' THEN
    IF NEW.state IS DISTINCT FROM OLD.state
       AND NOT (OLD.state = 'posted' AND NEW.state = 'superseded') THEN
      RAISE EXCEPTION 'physical_count % is % and cannot be mutated', OLD.id, OLD.state
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $function$;