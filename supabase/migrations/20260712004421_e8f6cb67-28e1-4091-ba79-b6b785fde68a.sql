CREATE TABLE IF NOT EXISTS public.payroll_number_sequences (
  organization_id uuid PRIMARY KEY,
  next_number integer NOT NULL DEFAULT 1,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT ALL ON public.payroll_number_sequences TO service_role;

ALTER TABLE public.payroll_number_sequences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Payroll sequence service role manages" ON public.payroll_number_sequences;
CREATE POLICY "Payroll sequence service role manages"
ON public.payroll_number_sequences
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.get_next_payroll_number(_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_next integer;
  v_existing_max integer;
BEGIN
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'organization id is required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.payroll_number_sequences (organization_id, next_number)
  VALUES (
    _org_id,
    COALESCE((
      SELECT MAX(NULLIF(regexp_replace(payroll_number, '^.*?(\d+)$', '\1'), payroll_number)::integer)
      FROM public.payroll_runs
      WHERE organization_id = _org_id
        AND payroll_number ~ '\d+$'
    ), 0) + 1
  )
  ON CONFLICT (organization_id) DO NOTHING;

  UPDATE public.payroll_number_sequences
     SET next_number = next_number + 1,
         updated_at = now()
   WHERE organization_id = _org_id
   RETURNING next_number - 1 INTO v_next;

  SELECT COALESCE(MAX(NULLIF(regexp_replace(payroll_number, '^.*?(\d+)$', '\1'), payroll_number)::integer), 0)
    INTO v_existing_max
    FROM public.payroll_runs
   WHERE organization_id = _org_id
     AND payroll_number ~ '\d+$';

  IF v_next <= v_existing_max THEN
    v_next := v_existing_max + 1;
    UPDATE public.payroll_number_sequences
       SET next_number = v_next + 1,
           updated_at = now()
     WHERE organization_id = _org_id;
  END IF;

  RETURN 'PAY-' || LPAD(v_next::text, 4, '0');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_next_payroll_number(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_next_payroll_number(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.approve_payroll_run(p_run_id uuid)
RETURNS payroll_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_run public.payroll_runs;
  v_allowed boolean;
  v_validation jsonb;
  v_missing text[];
  v_loan_check jsonb;
  v_loan_count int;
  v_adv_count int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payroll run not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_run.status = 'approved' THEN
    RETURN v_run;
  END IF;

  IF v_run.status NOT IN ('draft','processed') THEN
    RAISE EXCEPTION 'Payroll run is in status % and cannot be approved.', v_run.status;
  END IF;

  v_allowed := public.user_has_module_permission(
    v_uid, v_run.organization_id, 'payroll', 'approve'
  );
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'You do not have permission to approve payroll for this organization.'
      USING ERRCODE = '42501';
  END IF;

  v_validation := public.validate_payroll_run_mappings(p_run_id);
  IF NOT COALESCE((v_validation->>'ok')::boolean, false) THEN
    v_missing := COALESCE(
      ARRAY(SELECT jsonb_array_elements_text(v_validation->'missing_keys')),
      ARRAY[]::text[]
    );
    RAISE EXCEPTION
      'Cannot approve: % GL account mapping(s) missing — %. Configure them in Payroll → Configuration → GL Account Mapping.',
      cardinality(v_missing), array_to_string(v_missing, ', ')
      USING ERRCODE = 'P0001', HINT = 'payroll_missing_mappings';
  END IF;

  v_loan_check := public.validate_payroll_run_loan_integrity(p_run_id);
  IF NOT COALESCE((v_loan_check->>'ok')::boolean, false) THEN
    v_loan_count := jsonb_array_length(v_loan_check->'missing_loans');
    v_adv_count  := jsonb_array_length(v_loan_check->'missing_advances');

    IF v_adv_count > 0 AND v_loan_count = 0 THEN
      RAISE EXCEPTION
        'Cannot approve: % salary-advance installment(s) due in this period are not deducted on any payslip. Either re-run payroll to collect them or record an explicit skip override.',
        v_adv_count
        USING ERRCODE = 'P0001', HINT = 'payroll_advance_installment_missing';
    ELSIF v_loan_count > 0 AND v_adv_count = 0 THEN
      RAISE EXCEPTION
        'Cannot approve: % loan installment(s) due in this period are not deducted on any payslip. Either re-run payroll to collect them or record an explicit skip override.',
        v_loan_count
        USING ERRCODE = 'P0001', HINT = 'payroll_loan_installment_missing';
    ELSE
      RAISE EXCEPTION
        'Cannot approve: % loan installment(s) and % salary-advance installment(s) due in this period are not deducted on any payslip.',
        v_loan_count, v_adv_count
        USING ERRCODE = 'P0001', HINT = 'payroll_loan_installment_missing';
    END IF;
  END IF;

  UPDATE public.payroll_runs
     SET status = 'approved', approved_by = v_uid, approved_at = now(), updated_at = now()
   WHERE id = p_run_id
   RETURNING * INTO v_run;

  UPDATE public.payslips
     SET status = 'approved', updated_at = now()
   WHERE payroll_run_id = p_run_id
     AND organization_id = v_run.organization_id
     AND COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(v_run.business_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND status IN ('pending', 'draft');

  IF COALESCE(v_run.is_final_settlement, false) THEN
    PERFORM public.consume_pending_termination_payouts(p_run_id);
  END IF;

  RETURN v_run;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.approve_payroll_run(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_payroll_run(uuid) TO service_role;