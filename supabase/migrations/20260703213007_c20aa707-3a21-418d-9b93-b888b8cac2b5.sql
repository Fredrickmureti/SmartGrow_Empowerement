
-- Phase 3b: Cross-module lock cascade + write guards on payroll windows

-- 1. Helper: is the [from,to] window frozen for this business?
CREATE OR REPLACE FUNCTION public.payroll_period_frozen(
  _business_id uuid, _from date, _to date
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.payroll_periods p
    WHERE p.business_id = _business_id
      AND p.status IN ('closed'::public.payroll_period_status,
                       'archived'::public.payroll_period_status)
      AND daterange(p.start_date, p.end_date, '[]') && daterange(_from, _to, '[]')
  );
$$;
REVOKE ALL ON FUNCTION public.payroll_period_frozen(uuid, date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_period_frozen(uuid, date, date) TO authenticated, service_role;

-- 2. Guard trigger for payroll_runs (uses pay_period_start / pay_period_end + business_id)
CREATE OR REPLACE FUNCTION public.trg_guard_payroll_runs_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _biz uuid;
  _from date;
  _to date;
BEGIN
  -- Allow RPC-driven mutations that carry the sentinel
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
END $$;

DROP TRIGGER IF EXISTS guard_payroll_runs_period ON public.payroll_runs;
CREATE TRIGGER guard_payroll_runs_period
BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_runs
FOR EACH ROW EXECUTE FUNCTION public.trg_guard_payroll_runs_period();

-- 3. Guard trigger for payroll_return_runs (period_start / period_end + business_id)
CREATE OR REPLACE FUNCTION public.trg_guard_payroll_return_runs_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _biz uuid; _from date; _to date;
BEGIN
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
END $$;

DROP TRIGGER IF EXISTS guard_payroll_return_runs_period ON public.payroll_return_runs;
CREATE TRIGGER guard_payroll_return_runs_period
BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_return_runs
FOR EACH ROW EXECUTE FUNCTION public.trg_guard_payroll_return_runs_period();

-- 4. Guard trigger for payroll_bank_export_files (derive window through batch → run)
CREATE OR REPLACE FUNCTION public.trg_guard_payroll_bank_export_files_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _biz uuid; _from date; _to date; _batch_id uuid;
BEGIN
  IF current_setting('app.period_rpc', true) = 'payroll_period_transition' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  _batch_id := COALESCE(NEW.batch_id, OLD.batch_id);
  _biz := COALESCE(NEW.business_id, OLD.business_id);

  SELECT r.pay_period_start, r.pay_period_end
    INTO _from, _to
  FROM public.payroll_payment_batches b
  JOIN public.payroll_runs r ON r.id = b.payroll_run_id
  WHERE b.id = _batch_id;

  IF _biz IS NOT NULL AND _from IS NOT NULL AND _to IS NOT NULL
     AND public.payroll_period_frozen(_biz, _from, _to) THEN
    RAISE EXCEPTION 'payroll_bank_export_files write blocked: parent payroll period is closed/archived (business=%, window=% to %)',
      _biz, _from, _to USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS guard_payroll_bank_export_files_period ON public.payroll_bank_export_files;
CREATE TRIGGER guard_payroll_bank_export_files_period
BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_bank_export_files
FOR EACH ROW EXECUTE FUNCTION public.trg_guard_payroll_bank_export_files_period();

-- 5. Attendance unlock helper (mirror of attendance_lock_for_period)
CREATE OR REPLACE FUNCTION public.attendance_unlock_for_period(
  _organization_id uuid, _from date, _to date,
  _payroll_run_id uuid DEFAULT NULL, _employee_ids uuid[] DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int;
BEGIN
  UPDATE public.attendance
     SET is_locked = false,
         locked_by_payroll_run_id = NULL
   WHERE organization_id = _organization_id
     AND attendance_date BETWEEN _from AND _to
     AND is_locked = true
     AND (_payroll_run_id IS NULL OR locked_by_payroll_run_id = _payroll_run_id)
     AND (_employee_ids IS NULL OR employee_id = ANY(_employee_ids));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.attendance_unlock_for_period(uuid, date, date, uuid, uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION public.attendance_unlock_for_period(uuid, date, date, uuid, uuid[]) TO authenticated, service_role;

-- 6. Extend payroll_period_close_atomic: also lock attendance
CREATE OR REPLACE FUNCTION public.payroll_period_close_atomic(
  _period_id uuid,
  _reason text DEFAULT NULL,
  _force boolean DEFAULT false,
  _override_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _p public.payroll_periods;
  _readiness jsonb;
  _locked int := 0;
  _att_locked int := 0;
  _payload jsonb;
  _actor uuid := auth.uid();
BEGIN
  SELECT * INTO _p FROM public.payroll_periods WHERE id = _period_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll period % not found', _period_id USING ERRCODE = 'P0002';
  END IF;

  IF _actor IS NULL
     OR NOT public.user_has_module_permission(_actor, _p.organization_id, _p.business_id, 'payroll', 'manage') THEN
    RAISE EXCEPTION 'not authorized to close payroll period' USING ERRCODE = '42501';
  END IF;

  _readiness := public.payroll_period_readiness(_period_id);

  IF (_readiness->>'ready')::boolean IS DISTINCT FROM true AND NOT _force THEN
    RETURN jsonb_build_object('ok', false, 'code', 'blocked', 'readiness', _readiness);
  END IF;

  IF _force AND (_override_reason IS NULL OR length(trim(_override_reason)) = 0) THEN
    RAISE EXCEPTION 'override_reason required when forcing close over blockers' USING ERRCODE = '22023';
  END IF;

  UPDATE public.timesheets
     SET payroll_locked = true,
         payroll_locked_at = COALESCE(payroll_locked_at, now()),
         updated_at = now()
   WHERE business_id = _p.business_id
     AND date BETWEEN _p.start_date AND _p.end_date
     AND status = 'approved'
     AND payroll_locked IS DISTINCT FROM true;
  GET DIAGNOSTICS _locked = ROW_COUNT;

  _att_locked := public.attendance_lock_for_period(_p.organization_id, _p.start_date, _p.end_date);

  _payload := jsonb_build_object(
    'readiness', _readiness,
    'timesheets_locked', _locked,
    'attendance_locked', _att_locked,
    'force', _force,
    'override_reason', _override_reason
  );

  PERFORM public.payroll_period_transition(
    _period_id, 'closed'::public.payroll_period_status,
    COALESCE(_reason, _override_reason), _payload
  );

  RETURN jsonb_build_object(
    'ok', true, 'code', 'closed',
    'timesheets_locked', _locked,
    'attendance_locked', _att_locked,
    'readiness', _readiness
  );
END $$;
REVOKE ALL ON FUNCTION public.payroll_period_close_atomic(uuid, text, boolean, text) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_period_close_atomic(uuid, text, boolean, text) TO authenticated, service_role;

-- 7. Extend payroll_period_reopen_atomic: also unlock attendance
CREATE OR REPLACE FUNCTION public.payroll_period_reopen_atomic(
  _period_id uuid, _reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _p public.payroll_periods;
  _unlocked int := 0;
  _att_unlocked int := 0;
  _actor uuid := auth.uid();
BEGIN
  IF _reason IS NULL OR length(trim(_reason)) = 0 THEN
    RAISE EXCEPTION 'reason is required to reopen a closed payroll period' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO _p FROM public.payroll_periods WHERE id = _period_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll period % not found', _period_id USING ERRCODE = 'P0002';
  END IF;

  IF _actor IS NULL
     OR NOT (public.has_role(_actor, _p.organization_id, 'admin'::public.app_role)
             OR public.has_role(_actor, _p.organization_id, 'hr_admin'::public.app_role)
             OR public.has_role(_actor, _p.organization_id, 'payroll_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'not authorized to reopen payroll period' USING ERRCODE = '42501';
  END IF;

  UPDATE public.timesheets
     SET payroll_locked = false,
         payroll_locked_at = NULL,
         updated_at = now()
   WHERE business_id = _p.business_id
     AND date BETWEEN _p.start_date AND _p.end_date
     AND payroll_locked = true;
  GET DIAGNOSTICS _unlocked = ROW_COUNT;

  _att_unlocked := public.attendance_unlock_for_period(_p.organization_id, _p.start_date, _p.end_date);

  PERFORM public.payroll_period_transition(
    _period_id, 'reopened'::public.payroll_period_status, _reason,
    jsonb_build_object('timesheets_unlocked', _unlocked, 'attendance_unlocked', _att_unlocked)
  );

  RETURN jsonb_build_object(
    'ok', true, 'code', 'reopened',
    'timesheets_unlocked', _unlocked,
    'attendance_unlocked', _att_unlocked
  );
END $$;
REVOKE ALL ON FUNCTION public.payroll_period_reopen_atomic(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_period_reopen_atomic(uuid, text) TO authenticated, service_role;
