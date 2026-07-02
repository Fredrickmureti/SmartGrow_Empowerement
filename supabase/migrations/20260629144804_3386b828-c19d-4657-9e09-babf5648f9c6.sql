-- Phase 3.5 — Termination Liquidation Projector (read-only RPC).
-- A planning preview of an employee's final-pay liquidation BEFORE the
-- employment row flips to 'terminated'. Mirrors the components the
-- canonical engine would produce on a real termination run, but never
-- persists and does NOT compute statutory deductions (those must run
-- through compute-payroll on the live termination run, where the full
-- run-type policy + statutory rules are applied).

CREATE OR REPLACE FUNCTION public.payroll_project_termination(
  _employee_id uuid,
  _projected_termination_date date,
  _reason text DEFAULT NULL,
  _severance_days_per_year numeric DEFAULT 15,
  _notice_days numeric DEFAULT 30,
  _standard_working_days numeric DEFAULT 22
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp RECORD;
  v_contract RECORD;
  v_hire_date date;
  v_period_start date;
  v_days_worked_in_period int;
  v_period_total_days int;
  v_proration numeric;
  v_basic numeric := 0;
  v_housing numeric := 0;
  v_transport numeric := 0;
  v_daily_rate numeric := 0;
  v_years_of_service numeric := 0;
  v_leave_balance numeric := 0;
  v_leave_encashment numeric := 0;
  v_severance numeric := 0;
  v_notice numeric := 0;
  v_gross numeric := 0;
  v_caller uuid := auth.uid();
BEGIN
  IF _employee_id IS NULL THEN
    RAISE EXCEPTION 'employee_id required' USING HINT = 'BAD_INPUT';
  END IF;
  IF _projected_termination_date IS NULL THEN
    RAISE EXCEPTION 'projected_termination_date required' USING HINT = 'BAD_INPUT';
  END IF;
  IF _severance_days_per_year < 0 OR _notice_days < 0 OR _standard_working_days <= 0 THEN
    RAISE EXCEPTION 'invalid parameter (must be non-negative; working_days > 0)' USING HINT = 'BAD_INPUT';
  END IF;

  SELECT e.id, e.organization_id, e.business_id, e.hire_date,
         e.first_name, e.last_name, e.employee_number, e.termination_date
    INTO v_emp
  FROM public.employees e
  WHERE e.id = _employee_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'employee not found' USING HINT = 'NOT_FOUND';
  END IF;

  -- Authorization: caller must have access to the employee's business.
  -- Falls back open ONLY for service_role calls (no auth.uid()).
  IF v_caller IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = v_caller
      AND uba.business_id = v_emp.business_id
  ) THEN
    RAISE EXCEPTION 'forbidden' USING HINT = 'FORBIDDEN';
  END IF;

  v_hire_date := v_emp.hire_date;
  IF v_hire_date IS NULL OR _projected_termination_date < v_hire_date THEN
    RAISE EXCEPTION 'projected termination date precedes hire date' USING HINT = 'BAD_INPUT';
  END IF;

  -- Resolve the contract effective on the projected termination date.
  SELECT c.wage, c.housing_allowance, c.transport_allowance,
         c.start_date, c.end_date, c.status, c.id
    INTO v_contract
  FROM public.employee_contracts c
  WHERE c.employee_id = _employee_id
    AND c.start_date <= _projected_termination_date
    AND (c.end_date IS NULL OR c.end_date >= _projected_termination_date)
    AND c.status IN ('active','approved','signed')
  ORDER BY c.start_date DESC
  LIMIT 1;

  IF v_contract.id IS NULL THEN
    -- Fall back to most recent contract; still produce a projection but
    -- tag the response so the UI can show "no active contract" warning.
    SELECT c.wage, c.housing_allowance, c.transport_allowance,
           c.start_date, c.end_date, c.status, c.id
      INTO v_contract
    FROM public.employee_contracts c
    WHERE c.employee_id = _employee_id
    ORDER BY c.start_date DESC
    LIMIT 1;
  END IF;

  v_basic := COALESCE(v_contract.wage, 0);
  v_housing := COALESCE(v_contract.housing_allowance, 0);
  v_transport := COALESCE(v_contract.transport_allowance, 0);
  v_daily_rate := v_basic / _standard_working_days;

  -- Pro-rate the final pay period: month containing the termination date.
  v_period_start := date_trunc('month', _projected_termination_date)::date;
  v_period_total_days := (date_trunc('month', _projected_termination_date)
                         + INTERVAL '1 month - 1 day')::date - v_period_start + 1;
  v_days_worked_in_period := _projected_termination_date - v_period_start + 1;
  v_proration := LEAST(1.0,
    GREATEST(0.0, v_days_worked_in_period::numeric / GREATEST(1, v_period_total_days)::numeric));

  v_basic := round((v_basic * v_proration)::numeric, 2);
  v_housing := round((v_housing * v_proration)::numeric, 2);
  v_transport := round((v_transport * v_proration)::numeric, 2);

  -- Years of service (fractional).
  v_years_of_service := round(
    ((_projected_termination_date - v_hire_date)::numeric / 365.25)::numeric, 4
  );

  -- Leave encashment: sum of (allocated - used - pending) across active
  -- allocations whose effective_date <= projected date and not expired.
  SELECT COALESCE(SUM(
    GREATEST(0, COALESCE(la.days_allocated,0) - COALESCE(la.days_used,0) - COALESCE(la.days_pending,0))
  ), 0)
    INTO v_leave_balance
  FROM public.leave_allocations la
  WHERE la.employee_id = _employee_id
    AND la.effective_date <= _projected_termination_date
    AND (la.expiry_date IS NULL OR la.expiry_date >= _projected_termination_date);

  v_leave_encashment := round((v_leave_balance * v_daily_rate)::numeric, 2);
  v_severance := round((v_years_of_service * _severance_days_per_year * v_daily_rate)::numeric, 2);
  v_notice := round((_notice_days * v_daily_rate)::numeric, 2);

  v_gross := v_basic + v_housing + v_transport
           + v_leave_encashment + v_severance + v_notice;

  RETURN jsonb_build_object(
    'is_projection',           true,
    'employee_id',             v_emp.id,
    'employee_number',         v_emp.employee_number,
    'employee_name',           v_emp.first_name || ' ' || v_emp.last_name,
    'organization_id',         v_emp.organization_id,
    'business_id',             v_emp.business_id,
    'hire_date',               v_hire_date,
    'projected_termination_date', _projected_termination_date,
    'reason',                  _reason,
    'already_terminated',      (v_emp.termination_date IS NOT NULL),
    'contract_id',             v_contract.id,
    'contract_active_on_date', (v_contract.start_date <= _projected_termination_date
                                AND (v_contract.end_date IS NULL
                                     OR v_contract.end_date >= _projected_termination_date)),
    'standard_working_days',   _standard_working_days,
    'daily_rate',              round(v_daily_rate::numeric, 2),
    'years_of_service',        v_years_of_service,
    'proration_factor',        round(v_proration::numeric, 4),
    'components', jsonb_build_object(
      'final_period_basic',     v_basic,
      'final_period_housing',   v_housing,
      'final_period_transport', v_transport,
      'leave_encashment',       v_leave_encashment,
      'leave_balance_days',     v_leave_balance,
      'severance',              v_severance,
      'severance_days_per_year', _severance_days_per_year,
      'notice_pay',             v_notice,
      'notice_days',            _notice_days
    ),
    'gross_projected',         round(v_gross::numeric, 2),
    'statutory_deductions',    NULL,
    'net_projected',           NULL,
    'disclaimer',              'Projection only. Statutory deductions and the binding net amount are computed by compute-payroll on the live termination run.'
  );
END
$$;

REVOKE ALL ON FUNCTION public.payroll_project_termination(uuid, date, text, numeric, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_project_termination(uuid, date, text, numeric, numeric, numeric)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.payroll_project_termination(uuid, date, text, numeric, numeric, numeric) IS
  'Phase 3.5 — Read-only termination liquidation projector. Returns the gross-only preview of what a final-pay run would pay. Statutory deductions are NOT computed; the live compute-payroll engine remains authoritative on the actual termination run.';