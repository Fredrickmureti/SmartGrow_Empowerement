-- ─────────────────────────────────────────────────────────────────────
-- Settlement convergence — advance recovery leg
-- ─────────────────────────────────────────────────────────────────────

-- 1. Repair: this delegator still called the dropped 6-arg overload.
CREATE OR REPLACE FUNCTION public.process_payroll_loan_deductions(
  _payroll_run_id uuid,
  _payroll_number text,
  _deductions jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _ld jsonb;
  _amount numeric;
BEGIN
  FOR _ld IN SELECT * FROM jsonb_array_elements(_deductions)
  LOOP
    _amount := COALESCE((_ld->>'amount')::numeric, 0);
    IF _amount <= 0 THEN CONTINUE; END IF;
    PERFORM public.employee_loan_apply_repayment(
      (_ld->>'loan_id')::uuid,
      _amount,
      _payroll_run_id,
      NULLIF(_ld->>'payslip_id','')::uuid,
      'payroll',
      'Auto-deducted via payroll ' || COALESCE(_payroll_number,''),
      NULL,
      NULL
    );
  END LOOP;
END;
$$;

-- 2. Single writer for payroll-driven advance recovery. Mirrors
--    process_payroll_loan_deductions: the edge function hands over the
--    recovery list, the database owns schedule rows and balances.
CREATE OR REPLACE FUNCTION public.process_payroll_advance_recoveries(
  _payroll_run_id uuid,
  _payroll_number text,
  _period_start date,
  _period_end date,
  _recoveries jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _r          jsonb;
  _adv_id     uuid;
  _amount     numeric;
  _payslip    uuid;
  _adv        public.employee_advances%ROWTYPE;
  _new_recov  numeric;
  _exists     boolean;
BEGIN
  FOR _r IN SELECT * FROM jsonb_array_elements(_recoveries)
  LOOP
    _adv_id := (_r->>'advance_id')::uuid;
    _amount := COALESCE((_r->>'amount')::numeric, 0);
    _payslip := NULLIF(_r->>'payslip_id','')::uuid;
    IF _adv_id IS NULL OR _amount <= 0 THEN CONTINUE; END IF;

    SELECT * INTO _adv FROM public.employee_advances WHERE id = _adv_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    -- Idempotent replay: one recovery row per (advance, run).
    SELECT EXISTS (
      SELECT 1 FROM public.advance_repayment_schedule
       WHERE advance_id = _adv_id AND payroll_run_id = _payroll_run_id
    ) INTO _exists;
    IF _exists THEN CONTINUE; END IF;

    INSERT INTO public.advance_repayment_schedule (
      advance_id, organization_id, business_id,
      due_period_start, due_period_end,
      scheduled_amount, recovered_amount,
      payroll_run_id, payslip_id, status, notes)
    VALUES (
      _adv_id, _adv.organization_id, _adv.business_id,
      _period_start, _period_end,
      _amount, _amount,
      _payroll_run_id, _payslip, 'recovered',
      'Recovered via payroll ' || COALESCE(_payroll_number,''));

    _new_recov := COALESCE(_adv.recovered_amount, 0) + _amount;

    UPDATE public.employee_advances
       SET recovered_amount = _new_recov,
           status = CASE
                      WHEN _new_recov >= COALESCE(_adv.amount, 0) - 0.005
                        THEN 'recovered'::employee_advance_status
                      ELSE 'recovering'::employee_advance_status
                    END,
           updated_at = now()
     WHERE id = _adv_id;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.process_payroll_advance_recoveries(uuid, text, date, date, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_payroll_advance_recoveries(uuid, text, date, date, jsonb) TO service_role;

-- 3. GL targets for the recovery leg. An advance recovery is NOT a payable:
--    it relieves the advance receivable booked at disbursement (same reasoning
--    as ADR 0091 for loans). Payroll posting credits these accounts.
CREATE OR REPLACE FUNCTION public.payroll_advance_recovery_gl_targets(p_run_id uuid)
RETURNS TABLE (
  advance_id uuid,
  employee_name text,
  receivable_account_id uuid,
  amount numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.payroll_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF auth.uid() IS NOT NULL
     AND NOT public.is_org_member(auth.uid(), v_run.organization_id) THEN
    RAISE EXCEPTION 'Not authorized to inspect this payroll run' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT s.advance_id,
         COALESCE(e.first_name || ' ' || e.last_name, e.employee_number, '')::text,
         COALESCE(
           public.resolve_expense_default_account(a.organization_id, a.business_id, 'employee_advance_receivable'),
           public.resolve_expense_default_account(a.organization_id, a.business_id, 'loan_receivable')
         ),
         ROUND(SUM(s.recovered_amount), 2)
    FROM public.advance_repayment_schedule s
    JOIN public.employee_advances a ON a.id = s.advance_id
    LEFT JOIN public.employees e ON e.id = a.employee_id
   WHERE s.payroll_run_id = p_run_id
     AND COALESCE(s.recovered_amount, 0) > 0
   GROUP BY s.advance_id, e.first_name, e.last_name, e.employee_number,
            a.organization_id, a.business_id;
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_advance_recovery_gl_targets(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_advance_recovery_gl_targets(uuid) TO authenticated, service_role;