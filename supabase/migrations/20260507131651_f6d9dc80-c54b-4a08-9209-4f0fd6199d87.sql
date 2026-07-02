
CREATE OR REPLACE FUNCTION public.validate_payroll_run_inputs(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run RECORD;
  v_blockers int := 0;
  v_warnings int := 0;
  v_info int := 0;
  v_emp RECORD;
  v_has_contract boolean;
  v_has_structure boolean;
  v_has_bank boolean;
  v_unappr_corrections int;
  v_pack_country text;
  v_missing_idents int;
  v_contract_change int;
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll_run % not found', p_run_id;
  END IF;

  -- Clear previous findings for this run
  DELETE FROM public.payroll_run_issues WHERE payroll_run_id = p_run_id;

  -- Detect installed localization country (first active pack) — used for
  -- statutory-identifier checks. NULL means generic mode (no check).
  SELECT lp.country_code INTO v_pack_country
  FROM public.installed_localization_packs ilp
  JOIN public.localization_packs lp ON lp.id = ilp.pack_id
  WHERE ilp.organization_id = v_run.organization_id
    AND ilp.status = 'active'
  LIMIT 1;

  -- Iterate every employee with a payslip on this run (or every active employee
  -- in the org/business if no payslips yet — both produce the same flag set).
  FOR v_emp IN
    SELECT DISTINCT e.id, e.first_name, e.last_name, e.bank_account_number
    FROM public.employees e
    LEFT JOIN public.payslips ps ON ps.employee_id = e.id AND ps.payroll_run_id = p_run_id
    WHERE e.organization_id = v_run.organization_id
      AND COALESCE(e.business_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE(v_run.business_id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND e.is_active = true
      AND (e.termination_date IS NULL OR e.termination_date > v_run.pay_period_end)
  LOOP
    -- Active contract covering the period?
    SELECT EXISTS (
      SELECT 1 FROM public.employee_contracts c
      WHERE c.employee_id = v_emp.id
        AND c.status IN ('active','running','open')
        AND c.start_date <= v_run.pay_period_end
        AND (c.end_date IS NULL OR c.end_date >= v_run.pay_period_start)
    ) INTO v_has_contract;

    IF NOT v_has_contract THEN
      INSERT INTO public.payroll_run_issues
        (organization_id, business_id, payroll_run_id, employee_id, code, severity, message)
      VALUES (v_run.organization_id, v_run.business_id, p_run_id, v_emp.id,
        'missing_active_contract', 'blocker',
        format('%s %s has no active contract covering the pay period.', v_emp.first_name, v_emp.last_name));
      v_blockers := v_blockers + 1;
      CONTINUE;
    END IF;

    -- Salary structure assigned?
    SELECT EXISTS (
      SELECT 1 FROM public.employee_contracts c
      WHERE c.employee_id = v_emp.id
        AND c.status IN ('active','running','open')
        AND c.salary_structure_id IS NOT NULL
    ) INTO v_has_structure;
    IF NOT v_has_structure THEN
      INSERT INTO public.payroll_run_issues
        (organization_id, business_id, payroll_run_id, employee_id, code, severity, message)
      VALUES (v_run.organization_id, v_run.business_id, p_run_id, v_emp.id,
        'missing_salary_structure', 'warning',
        format('%s %s has no salary structure on the active contract.', v_emp.first_name, v_emp.last_name));
      v_warnings := v_warnings + 1;
    END IF;

    -- Bank/payout details
    v_has_bank := v_emp.bank_account_number IS NOT NULL AND length(v_emp.bank_account_number) > 0;
    IF NOT v_has_bank THEN
      INSERT INTO public.payroll_run_issues
        (organization_id, business_id, payroll_run_id, employee_id, code, severity, message)
      VALUES (v_run.organization_id, v_run.business_id, p_run_id, v_emp.id,
        'missing_payout_method', 'warning',
        format('%s %s has no bank account on file.', v_emp.first_name, v_emp.last_name));
      v_warnings := v_warnings + 1;
    END IF;

    -- Unapproved attendance corrections inside the period
    SELECT count(*) INTO v_unappr_corrections
    FROM public.attendance_corrections ac
    WHERE ac.employee_id = v_emp.id
      AND ac.attendance_date BETWEEN v_run.pay_period_start AND v_run.pay_period_end
      AND ac.status = 'pending';
    IF v_unappr_corrections > 0 THEN
      INSERT INTO public.payroll_run_issues
        (organization_id, business_id, payroll_run_id, employee_id, code, severity, message, details)
      VALUES (v_run.organization_id, v_run.business_id, p_run_id, v_emp.id,
        'unapproved_attendance_corrections', 'warning',
        format('%s pending attendance corrections in the pay period.', v_unappr_corrections),
        jsonb_build_object('count', v_unappr_corrections));
      v_warnings := v_warnings + 1;
    END IF;

    -- Statutory identifiers (only when a country pack is installed)
    IF v_pack_country IS NOT NULL THEN
      SELECT count(*) INTO v_missing_idents
      FROM public.payroll_statutory_rules r
      WHERE r.organization_id = v_run.organization_id
        AND r.country_code = v_pack_country
        AND r.is_active = true
        AND COALESCE((r.parameters->>'requires_identifier'), '') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM public.employee_statutory_identifiers ei
          WHERE ei.employee_id = v_emp.id
            AND ei.country_code = v_pack_country
            AND ei.identifier_type = (r.parameters->>'requires_identifier')
            AND ei.is_active = true
        );
      IF v_missing_idents > 0 THEN
        INSERT INTO public.payroll_run_issues
          (organization_id, business_id, payroll_run_id, employee_id, code, severity, message, details)
        VALUES (v_run.organization_id, v_run.business_id, p_run_id, v_emp.id,
          'missing_statutory_identifier', 'warning',
          format('%s missing statutory identifier(s) required by %s rules.', v_missing_idents, v_pack_country),
          jsonb_build_object('count', v_missing_idents, 'country', v_pack_country));
        v_warnings := v_warnings + 1;
      END IF;
    END IF;

    -- Contract change mid-period
    SELECT count(*) INTO v_contract_change
    FROM public.employee_contracts c
    WHERE c.employee_id = v_emp.id
      AND c.start_date > v_run.pay_period_start
      AND c.start_date <= v_run.pay_period_end;
    IF v_contract_change > 0 THEN
      INSERT INTO public.payroll_run_issues
        (organization_id, business_id, payroll_run_id, employee_id, code, severity, message)
      VALUES (v_run.organization_id, v_run.business_id, p_run_id, v_emp.id,
        'contract_change_mid_period', 'info',
        format('%s %s has a contract change inside this pay period — verify proration.', v_emp.first_name, v_emp.last_name));
      v_info := v_info + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', v_blockers = 0,
    'blockers', v_blockers,
    'warnings', v_warnings,
    'info', v_info,
    'country_code', v_pack_country
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.validate_payroll_run_inputs(uuid) TO authenticated;
