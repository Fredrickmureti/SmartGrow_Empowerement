-- ─── 1. Reversal preview RPC ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.payroll_run_reversal_preview(_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _run record;
  _result jsonb;
BEGIN
  SELECT id, organization_id, business_id, payroll_number, status,
         pay_period_start, pay_period_end,
         total_gross, total_net, employee_count
    INTO _run
  FROM public.payroll_runs
  WHERE id = _run_id;

  IF _run.id IS NULL THEN
    RAISE EXCEPTION 'Payroll run not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_org_member(_run.organization_id) THEN
    RAISE EXCEPTION 'Not a member of this organization' USING ERRCODE = '42501';
  END IF;

  IF _run.status NOT IN ('posted', 'paid') THEN
    RAISE EXCEPTION 'Only posted or paid runs can be reversed (status=%)', _run.status
      USING ERRCODE = '22023';
  END IF;

  WITH jes AS (
    SELECT id, entry_number, entry_date, total_debit, total_credit, status
      FROM public.journal_entries
     WHERE organization_id = _run.organization_id
       AND source_type = 'payroll'
       AND source_id   = _run.id
       AND status <> 'voided'
  ),
  ps AS (
    SELECT p.id, p.employee_id, p.gross_pay, p.net_pay,
           e.first_name, e.last_name, e.employee_number
      FROM public.payslips p
      LEFT JOIN public.employees e ON e.id = p.employee_id
     WHERE p.payroll_run_id = _run.id
  )
  SELECT jsonb_build_object(
    'run', jsonb_build_object(
      'id',              _run.id,
      'payroll_number',  _run.payroll_number,
      'status',          _run.status,
      'pay_period_start',_run.pay_period_start,
      'pay_period_end',  _run.pay_period_end,
      'total_gross',     _run.total_gross,
      'total_net',       _run.total_net,
      'employee_count',  _run.employee_count
    ),
    'journal_entries', COALESCE((SELECT jsonb_agg(to_jsonb(jes.*)) FROM jes), '[]'::jsonb),
    'journal_entry_count',
       COALESCE((SELECT count(*) FROM jes), 0),
    'gl_total_debit',
       COALESCE((SELECT sum(total_debit) FROM jes), 0),
    'payslips', COALESCE((
       SELECT jsonb_agg(jsonb_build_object(
         'payslip_id',      ps.id,
         'employee_id',     ps.employee_id,
         'employee_name',   trim(both ' ' from coalesce(ps.first_name,'') || ' ' || coalesce(ps.last_name,'')),
         'employee_number', ps.employee_number,
         'gross_pay',       ps.gross_pay,
         'net_pay',         ps.net_pay,
         'reverse_net',    -ps.net_pay
       ) ORDER BY ps.employee_number) FROM ps
    ), '[]'::jsonb),
    'payslip_count', COALESCE((SELECT count(*) FROM ps), 0),
    'has_gl_entry',  EXISTS(SELECT 1 FROM jes)
  )
  INTO _result;

  RETURN _result;
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_run_reversal_preview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_run_reversal_preview(uuid) TO authenticated;

-- ─── 2. Backfill computation_method on legacy rules ──────────────────────
-- Mirrors src/lib/payroll/computationMethods.ts inferComputationMethod().
DO $$
DECLARE
  r record;
  inferred text;
  params jsonb;
  first_bracket jsonb;
BEGIN
  FOR r IN
    SELECT id, parameters
      FROM public.payroll_statutory_rules
     WHERE computation_method IS NULL
        OR computation_method = ''
        OR computation_method = 'auto'
  LOOP
    params := COALESCE(r.parameters, '{}'::jsonb);
    inferred := NULL;

    IF jsonb_typeof(params->'tiers') = 'array'
       AND jsonb_array_length(params->'tiers') > 0 THEN
      inferred := 'tiered_brackets';
    ELSIF jsonb_typeof(params->'brackets') = 'array'
          AND jsonb_array_length(params->'brackets') > 0 THEN
      first_bracket := params->'brackets'->0;
      IF first_bracket ? 'rate' THEN
        inferred := 'bracket_progressive';
      ELSIF first_bracket ? 'amount' THEN
        inferred := 'graduated_table';
      ELSE
        inferred := 'bracket_progressive';
      END IF;
    ELSIF params ? 'amount_per_employee' THEN
      inferred := 'per_employee_flat';
    ELSIF (params ? 'amount') AND NOT (params ? 'rate') THEN
      inferred := 'flat_amount';
    ELSIF (params ? 'rate') OR (params ? 'employee_rate') OR (params ? 'employer_rate') THEN
      inferred := 'percentage_of_gross';
    END IF;

    IF inferred IS NOT NULL THEN
      UPDATE public.payroll_statutory_rules
         SET computation_method = inferred,
             parameters         = params || jsonb_build_object('_inferred', true)
       WHERE id = r.id;
    END IF;
  END LOOP;
END $$;