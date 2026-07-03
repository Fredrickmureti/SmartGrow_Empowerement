
-- =====================================================================
-- Phase 3 — Cross-module payroll-period write guards
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Shared helper: is this period writable right now?
--    - Sentinel `app.period_bypass=on` lets sanctioned RPCs pass (e.g.
--      payroll_period_reopen_atomic when unlocking timesheets it just
--      locked). Callers set/reset within their own txn scope.
--    - Admin / hr_admin / payroll_admin retain an override so backfills
--      and corrections remain possible.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_period_is_writable(_period_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _status public.payroll_period_status;
  _org uuid;
  _actor uuid := auth.uid();
BEGIN
  IF _period_id IS NULL THEN
    RETURN true;
  END IF;

  SELECT status, organization_id INTO _status, _org
  FROM public.payroll_periods WHERE id = _period_id;

  IF NOT FOUND THEN
    RETURN true;
  END IF;

  IF _status NOT IN ('closed','archived','cancelled') THEN
    RETURN true;
  END IF;

  IF COALESCE(current_setting('app.period_bypass', true),'') = 'on' THEN
    RETURN true;
  END IF;

  IF _actor IS NOT NULL AND (
       public.has_role(_actor, _org, 'admin'::public.app_role)
    OR public.has_role(_actor, _org, 'hr_admin'::public.app_role)
    OR public.has_role(_actor, _org, 'payroll_admin'::public.app_role)
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END $$;

REVOKE ALL ON FUNCTION public.payroll_period_is_writable(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_period_is_writable(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. Period resolver by (business_id, on_date)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_period_for_date(_business_id uuid, _on date)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM public.payroll_periods
  WHERE business_id = _business_id
    AND _on BETWEEN start_date AND end_date
  ORDER BY start_date DESC
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.payroll_period_for_date(uuid, date) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_period_for_date(uuid, date) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Guard triggers per table
-- ---------------------------------------------------------------------

-- 3a. payroll_runs — guard by explicit period_id or (business,date) fallback
CREATE OR REPLACE FUNCTION public.trg_guard_payroll_runs_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _pid uuid;
BEGIN
  _pid := COALESCE(NEW.period_id,
    public.payroll_period_for_date(NEW.business_id, NEW.pay_period_end));
  IF NOT public.payroll_period_is_writable(_pid) THEN
    RAISE EXCEPTION 'payroll period % is closed/archived; cannot write payroll_run', _pid
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_payroll_runs_period ON public.payroll_runs;
CREATE TRIGGER trg_guard_payroll_runs_period
BEFORE INSERT OR UPDATE ON public.payroll_runs
FOR EACH ROW EXECUTE FUNCTION public.trg_guard_payroll_runs_period();

-- 3b. payroll_work_entries — resolve via linked payroll_run
CREATE OR REPLACE FUNCTION public.trg_guard_payroll_work_entries_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _pid uuid;
BEGIN
  SELECT COALESCE(r.period_id, public.payroll_period_for_date(r.business_id, r.pay_period_end))
    INTO _pid
    FROM public.payroll_runs r WHERE r.id = NEW.payroll_run_id;
  IF NOT public.payroll_period_is_writable(_pid) THEN
    RAISE EXCEPTION 'parent payroll period % is closed; cannot modify payroll_work_entries', _pid
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_payroll_work_entries_period ON public.payroll_work_entries;
CREATE TRIGGER trg_guard_payroll_work_entries_period
BEFORE INSERT OR UPDATE ON public.payroll_work_entries
FOR EACH ROW EXECUTE FUNCTION public.trg_guard_payroll_work_entries_period();

-- 3c. payslip_inputs — resolve via linked payroll_run
CREATE OR REPLACE FUNCTION public.trg_guard_payslip_inputs_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _pid uuid;
BEGIN
  IF NEW.payroll_run_id IS NULL THEN RETURN NEW; END IF;
  SELECT COALESCE(r.period_id, public.payroll_period_for_date(r.business_id, r.pay_period_end))
    INTO _pid
    FROM public.payroll_runs r WHERE r.id = NEW.payroll_run_id;
  IF NOT public.payroll_period_is_writable(_pid) THEN
    RAISE EXCEPTION 'parent payroll period % is closed; cannot modify payslip_inputs', _pid
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_payslip_inputs_period ON public.payslip_inputs;
CREATE TRIGGER trg_guard_payslip_inputs_period
BEFORE INSERT OR UPDATE ON public.payslip_inputs
FOR EACH ROW EXECUTE FUNCTION public.trg_guard_payslip_inputs_period();

-- 3d. attendance_corrections — guard by (business,attendance_date)
CREATE OR REPLACE FUNCTION public.trg_guard_attendance_corrections_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _pid uuid;
BEGIN
  _pid := public.payroll_period_for_date(NEW.business_id, NEW.attendance_date);
  IF NOT public.payroll_period_is_writable(_pid) THEN
    RAISE EXCEPTION 'payroll period % is closed; cannot modify attendance_corrections', _pid
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_attendance_corrections_period ON public.attendance_corrections;
CREATE TRIGGER trg_guard_attendance_corrections_period
BEFORE INSERT OR UPDATE ON public.attendance_corrections
FOR EACH ROW EXECUTE FUNCTION public.trg_guard_attendance_corrections_period();

-- 3e. timesheets — extend the existing payroll_locked semantics with a
-- parent-period check. Existing per-row lock guard is unchanged; this
-- adds a second gate for rows in a closed/archived period even if the
-- row itself hasn't been individually flagged locked yet.
CREATE OR REPLACE FUNCTION public.trg_guard_timesheets_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _pid uuid;
BEGIN
  _pid := COALESCE(NEW.payroll_period_id,
    public.payroll_period_for_date(NEW.business_id, NEW.date));
  IF NOT public.payroll_period_is_writable(_pid) THEN
    RAISE EXCEPTION 'payroll period % is closed; cannot modify timesheet', _pid
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_timesheets_period ON public.timesheets;
CREATE TRIGGER trg_guard_timesheets_period
BEFORE INSERT OR UPDATE ON public.timesheets
FOR EACH ROW EXECUTE FUNCTION public.trg_guard_timesheets_period();

-- ---------------------------------------------------------------------
-- 4. Let the atomic close/reopen RPCs bypass their own guards while they
--    perform the cascade. We wrap the update statements with the sentinel.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_period_close_atomic(
  _period_id uuid,
  _reason text DEFAULT NULL,
  _force boolean DEFAULT false,
  _override_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _p public.payroll_periods;
  _readiness jsonb;
  _locked int := 0;
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

  PERFORM set_config('app.period_bypass', 'on', true);

  UPDATE public.timesheets
     SET payroll_locked = true,
         payroll_locked_at = COALESCE(payroll_locked_at, now()),
         updated_at = now()
   WHERE business_id = _p.business_id
     AND date BETWEEN _p.start_date AND _p.end_date
     AND status = 'approved'
     AND payroll_locked IS DISTINCT FROM true;
  GET DIAGNOSTICS _locked = ROW_COUNT;

  PERFORM set_config('app.period_bypass', '', true);

  _payload := jsonb_build_object(
    'readiness', _readiness,
    'timesheets_locked', _locked,
    'force', _force,
    'override_reason', _override_reason
  );

  PERFORM public.payroll_period_transition(
    _period_id, 'closed'::public.payroll_period_status,
    COALESCE(_reason, _override_reason), _payload);

  RETURN jsonb_build_object('ok', true, 'code', 'closed',
    'timesheets_locked', _locked, 'readiness', _readiness);
END $$;

CREATE OR REPLACE FUNCTION public.payroll_period_reopen_atomic(
  _period_id uuid, _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _p public.payroll_periods;
  _unlocked int := 0;
  _actor uuid := auth.uid();
BEGIN
  IF _reason IS NULL OR length(trim(_reason)) = 0 THEN
    RAISE EXCEPTION 'reason is required to reopen a closed payroll period' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO _p FROM public.payroll_periods WHERE id = _period_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll period % not found', _period_id USING ERRCODE = 'P0002';
  END IF;

  IF _actor IS NULL OR NOT (
       public.has_role(_actor, _p.organization_id, 'admin'::public.app_role)
    OR public.has_role(_actor, _p.organization_id, 'hr_admin'::public.app_role)
    OR public.has_role(_actor, _p.organization_id, 'payroll_admin'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized to reopen payroll period' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.period_bypass', 'on', true);

  UPDATE public.timesheets
     SET payroll_locked = false,
         payroll_locked_at = NULL,
         updated_at = now()
   WHERE business_id = _p.business_id
     AND date BETWEEN _p.start_date AND _p.end_date
     AND payroll_locked = true;
  GET DIAGNOSTICS _unlocked = ROW_COUNT;

  PERFORM set_config('app.period_bypass', '', true);

  PERFORM public.payroll_period_transition(
    _period_id, 'reopened'::public.payroll_period_status,
    _reason, jsonb_build_object('timesheets_unlocked', _unlocked));

  RETURN jsonb_build_object('ok', true, 'code', 'reopened',
    'timesheets_unlocked', _unlocked);
END $$;
