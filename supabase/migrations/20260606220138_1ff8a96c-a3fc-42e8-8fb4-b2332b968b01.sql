
ALTER TABLE public.retro_pay_adjustments
  ADD COLUMN IF NOT EXISTS delta_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS delta_gross numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delta_employee_deductions numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delta_net numeric(18,2) NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.enqueue_retro_pay_adjustment(
  _source_payslip_id uuid,
  _effective_from date,
  _reason text,
  _delta_lines jsonb,
  _delta_gross numeric,
  _delta_employee_deductions numeric,
  _delta_net numeric
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _src record;
  _id uuid;
BEGIN
  SELECT id, organization_id, business_id, employee_id, payroll_run_id
    INTO _src
    FROM public.payslips
   WHERE id = _source_payslip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source payslip % not found', _source_payslip_id
      USING HINT = 'retro_source_missing';
  END IF;

  INSERT INTO public.retro_pay_adjustments (
    organization_id, business_id, employee_id, source_payslip_id,
    effective_from, period_start, period_end, reason, status,
    delta_lines, delta_gross, delta_employee_deductions, delta_net,
    created_by
  )
  SELECT
    _src.organization_id, _src.business_id, _src.employee_id, _source_payslip_id,
    _effective_from, pr.pay_period_start, pr.pay_period_end, _reason, 'pending',
    COALESCE(_delta_lines, '[]'::jsonb),
    COALESCE(_delta_gross, 0),
    COALESCE(_delta_employee_deductions, 0),
    COALESCE(_delta_net, 0),
    auth.uid()
  FROM public.payroll_runs pr
  WHERE pr.id = _src.payroll_run_id
  ON CONFLICT (source_payslip_id, status) DO UPDATE
     SET effective_from           = EXCLUDED.effective_from,
         reason                   = EXCLUDED.reason,
         delta_lines              = EXCLUDED.delta_lines,
         delta_gross              = EXCLUDED.delta_gross,
         delta_employee_deductions = EXCLUDED.delta_employee_deductions,
         delta_net                = EXCLUDED.delta_net,
         updated_at               = now()
  RETURNING id INTO _id;

  RETURN _id;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_retro_pay_adjustment(uuid, date, text, jsonb, numeric, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_retro_pay_adjustment(uuid, date, text, jsonb, numeric, numeric, numeric) TO authenticated, service_role;
