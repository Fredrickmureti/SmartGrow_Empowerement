
CREATE OR REPLACE FUNCTION public.handle_exit_clearance_completion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp record;
  v_outstanding numeric;
  v_run_id uuid;
  v_period_start date;
  v_number text;
BEGIN
  -- Only act on transitions INTO 'completed'
  IF NEW.status IS DISTINCT FROM 'completed'
     OR (TG_OP = 'UPDATE' AND OLD.status = 'completed') THEN
    RETURN NEW;
  END IF;

  -- Block: unsettled loans must be cleared before final settlement runs
  SELECT COALESCE(SUM(outstanding_balance), 0)
    INTO v_outstanding
  FROM public.employee_loans
  WHERE employee_id = NEW.employee_id
    AND status IN ('active','suspended')
    AND COALESCE(outstanding_balance, 0) > 0;

  IF v_outstanding > 0 THEN
    RAISE EXCEPTION
      'Cannot complete exit clearance: employee has unsettled loan balance of %. Settle or write off in Finance before closing clearance.',
      v_outstanding
      USING ERRCODE = 'P0001',
            HINT    = 'exit_clearance_unsettled_loans';
  END IF;

  -- Already linked → nothing to create (manual run from termination dialog)
  IF NEW.final_pay_run_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT id, first_name, last_name, employee_number, organization_id, business_id
    INTO v_emp
  FROM public.employees
  WHERE id = NEW.employee_id;

  IF NOT FOUND THEN
    RETURN NEW; -- employee gone; let HR sort it
  END IF;

  v_period_start := date_trunc('month', NEW.last_working_day)::date;
  v_number := 'FS-' || COALESCE(v_emp.employee_number, substring(v_emp.id::text, 1, 6))
              || '-' || to_char(NEW.last_working_day, 'YYYY-MM-DD');

  INSERT INTO public.payroll_runs (
    organization_id,
    business_id,
    payroll_number,
    pay_period_start,
    pay_period_end,
    payment_date,
    status,
    run_type,
    is_final_settlement,
    final_settlement_employee_id,
    created_by,
    notes
  ) VALUES (
    NEW.organization_id,
    COALESCE(NEW.business_id, v_emp.business_id),
    v_number,
    v_period_start,
    NEW.last_working_day,
    NEW.last_working_day,
    'draft',
    'final_settlement',
    true,
    NEW.employee_id,
    auth.uid(),
    'Auto-generated on exit clearance completion for '
      || COALESCE(v_emp.first_name, '') || ' ' || COALESCE(v_emp.last_name, '')
  )
  RETURNING id INTO v_run_id;

  NEW.final_pay_run_id := v_run_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_exit_clearance_completion ON public.employee_exit_clearance;
CREATE TRIGGER trg_exit_clearance_completion
BEFORE UPDATE ON public.employee_exit_clearance
FOR EACH ROW
EXECUTE FUNCTION public.handle_exit_clearance_completion();
