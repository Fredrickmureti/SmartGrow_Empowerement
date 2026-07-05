CREATE OR REPLACE FUNCTION public.approve_payroll_run(p_run_id uuid)
 RETURNS public.payroll_runs
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

  -- Phase 5 gate: required GL mappings
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

  -- Wave 2.4 / 2.4-bis: loan & salary-advance deduction integrity
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

  -- Approval is the immutable payroll finalisation event. Keep cash payment
  -- separate: pending computed payslips become approved, never paid.
  UPDATE public.payslips
     SET status = 'approved', updated_at = now()
   WHERE payroll_run_id = p_run_id
     AND organization_id = v_run.organization_id
     AND COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(v_run.business_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND status IN ('pending', 'draft');

  -- Wave 3.6: atomically consume pending termination payouts for final-settlement runs.
  IF COALESCE(v_run.is_final_settlement, false) THEN
    PERFORM public.consume_pending_termination_payouts(p_run_id);
  END IF;

  RETURN v_run;
END;
$function$;

REVOKE ALL ON FUNCTION public.approve_payroll_run(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_payroll_run(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_payroll_run(uuid) TO service_role;