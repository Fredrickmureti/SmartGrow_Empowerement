
-- 1. Add is_statutory to leave_types (idempotent)
ALTER TABLE public.leave_types
  ADD COLUMN IF NOT EXISTS is_statutory boolean NOT NULL DEFAULT false;

-- 2. Replace the readiness evaluator with all existing branches + new ones
CREATE OR REPLACE FUNCTION public.payroll_readiness_eval_rule(
  p_rule payroll_readiness_rules, p_org_id uuid, p_business_id uuid,
  p_subject_id uuid, p_period_start date, p_period_end date
)
RETURNS TABLE(status text, reason text, missing_fields text[], details jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text := 'pass';
  v_reason text;
  v_missing text[] := ARRAY[]::text[];
  v_details jsonb := '{}'::jsonb;
  v_invalid text;
  v_count int;
  v_business uuid;
  v_tracks_timesheets boolean;
  v_missing_leave text;
BEGIN
  CASE p_rule.check_kind

  WHEN 'org.localization_pack_installed' THEN
    IF NOT EXISTS (SELECT 1 FROM installed_localization_packs WHERE organization_id = p_org_id) THEN
      v_status := 'fail'; v_reason := 'No localization pack installed for this organization.';
      v_missing := ARRAY['localization_pack'];
    END IF;

  WHEN 'org.salary_structure_active' THEN
    IF NOT EXISTS (SELECT 1 FROM salary_structures WHERE organization_id = p_org_id AND is_active = true) THEN
      v_status := 'fail'; v_reason := 'No active salary structure has been defined.';
      v_missing := ARRAY['salary_structure'];
    END IF;

  WHEN 'org.payroll_accounts_mapped' THEN
    IF NOT EXISTS (
      SELECT 1 FROM default_account_settings
      WHERE organization_id = p_org_id AND account_id IS NOT NULL
        AND (p_business_id IS NULL OR business_id IS NULL OR business_id = p_business_id)
    ) THEN
      v_status := 'fail'; v_reason := 'Payroll GL accounts have not been mapped.';
      v_missing := ARRAY['payroll_gl_accounts'];
    END IF;

  WHEN 'org.statutory_rules_active' THEN
    IF NOT EXISTS (
      SELECT 1 FROM payroll_statutory_rules
      WHERE organization_id = p_org_id AND is_active = true
        AND (effective_to IS NULL OR effective_to >= COALESCE(p_period_end, CURRENT_DATE))
    ) THEN
      v_status := 'fail'; v_reason := 'No active statutory rules in effect for the period.';
      v_missing := ARRAY['statutory_rules'];
    END IF;

  WHEN 'org.statutory_rules_valid_method' THEN
    SELECT string_agg(rule_name, ', ' ORDER BY rule_name) INTO v_invalid
      FROM payroll_statutory_rules
     WHERE organization_id = p_org_id AND is_active = true
       AND (effective_to IS NULL OR effective_to >= COALESCE(p_period_end, CURRENT_DATE))
       AND (computation_method IS NULL OR lower(trim(computation_method)) IN ('','unknown','auto'));
    IF v_invalid IS NOT NULL AND length(v_invalid) > 0 THEN
      v_status := 'fail';
      v_reason := 'Statutory rules with invalid computation_method: ' || v_invalid;
      v_missing := ARRAY['statutory_rule_method'];
      v_details := jsonb_build_object('invalid_rules', v_invalid);
    END IF;

  WHEN 'org.payroll_period_exists' THEN
    IF NOT EXISTS (
      SELECT 1 FROM payroll_periods
      WHERE organization_id = p_org_id
        AND (p_business_id IS NULL OR business_id = p_business_id)
    ) THEN
      v_status := 'fail'; v_reason := 'No payroll periods have been generated.';
      v_missing := ARRAY['payroll_periods'];
    END IF;

  WHEN 'employee.active_contract' THEN
    IF NOT EXISTS (
      SELECT 1 FROM employee_contracts ec
      WHERE ec.organization_id = p_org_id AND ec.employee_id = p_subject_id
        AND ec.status IN ('running','new','active')
        AND (p_business_id IS NULL OR ec.business_id = p_business_id)
        AND (p_period_end IS NULL OR ec.start_date <= p_period_end)
        AND (p_period_start IS NULL OR ec.end_date IS NULL OR ec.end_date >= p_period_start)
    ) THEN
      v_status := 'fail'; v_reason := 'Employee has no active contract for the period.';
      v_missing := ARRAY['employee_contract'];
    END IF;

  WHEN 'employee.contract_has_salary' THEN
    IF NOT EXISTS (
      SELECT 1 FROM employee_contracts ec
      WHERE ec.organization_id = p_org_id AND ec.employee_id = p_subject_id
        AND ec.status IN ('running','new','active') AND COALESCE(ec.wage, 0) > 0
    ) THEN
      v_status := 'fail'; v_reason := 'Active contract has no wage / salary amount.';
      v_missing := ARRAY['contract_wage'];
    END IF;

  WHEN 'employee.contract_has_schedule' THEN
    IF NOT EXISTS (
      SELECT 1 FROM employee_contracts ec
      WHERE ec.organization_id = p_org_id AND ec.employee_id = p_subject_id
        AND ec.status IN ('running','new','active') AND ec.working_schedule IS NOT NULL
    ) THEN
      v_status := 'fail'; v_reason := 'Active contract has no working schedule.';
      v_missing := ARRAY['contract_schedule'];
    END IF;

  WHEN 'employee.has_statutory_identifiers' THEN
    IF NOT EXISTS (SELECT 1 FROM employee_statutory_identifiers WHERE employee_id = p_subject_id) THEN
      v_status := 'warn'; v_reason := 'Employee has no statutory identifiers recorded.';
      v_missing := ARRAY['statutory_identifiers'];
    END IF;

  WHEN 'employee.has_payment_info' THEN
    IF NOT EXISTS (
      SELECT 1 FROM employees
      WHERE id = p_subject_id
        AND (bank_account_number IS NOT NULL OR bank_name IS NOT NULL)
    ) THEN
      v_status := 'warn'; v_reason := 'Employee has no bank / payment information.';
      v_missing := ARRAY['payment_info'];
    END IF;

  WHEN 'employee.statutory_fields_required' THEN
    v_business := COALESCE(
      p_business_id,
      (SELECT business_id FROM public.employees WHERE id = p_subject_id)
    );
    SELECT COALESCE(array_agg(req.requirement_key ORDER BY req.sort_order), ARRAY[]::text[])
      INTO v_missing
    FROM (
      SELECT DISTINCT ON (requirement_key)
        requirement_key, sort_order, is_required, is_active, blocks_payroll
      FROM public.pack_requirements
      WHERE business_id = v_business
        AND scope = 'statutory_identifier'
      ORDER BY requirement_key,
        CASE source WHEN 'tenant_override' THEN 0 ELSE 1 END
    ) req
    WHERE req.is_active = true
      AND req.is_required = true
      AND req.blocks_payroll = true
      AND NOT EXISTS (
        SELECT 1 FROM public.employee_statutory_identifiers esi
        WHERE esi.employee_id = p_subject_id
          AND esi.identifier_type = req.requirement_key
          AND COALESCE(esi.identifier_value, '') <> ''
      );
    IF array_length(v_missing, 1) IS NOT NULL THEN
      v_status := 'fail';
      v_reason := 'Required statutory identifiers missing: ' || array_to_string(v_missing, ', ');
      v_details := jsonb_build_object('missing', v_missing, 'source', 'pack_requirements');
    END IF;

  WHEN 'employee.exit_clearance_cleared' THEN
    IF EXISTS (
      SELECT 1 FROM employee_exit_clearance ec
      JOIN employee_exit_clearance_items i ON i.exit_clearance_id = ec.id
      WHERE ec.employee_id = p_subject_id
        AND ec.organization_id = p_org_id
        AND ec.status NOT IN ('completed','cancelled')
        AND i.is_blocking = true
        AND i.status <> 'cleared'
    ) THEN
      v_status := 'fail'; v_reason := 'Open exit clearance has unresolved blocking items.';
      v_missing := ARRAY['exit_clearance'];
    END IF;

  WHEN 'employee.timesheets_approved' THEN
    SELECT (ec.time_tracking_source = 'timesheets') INTO v_tracks_timesheets
      FROM employee_contracts ec
     WHERE ec.organization_id = p_org_id AND ec.employee_id = p_subject_id
       AND ec.status IN ('running','new','active')
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF COALESCE(v_tracks_timesheets, false) AND p_period_start IS NOT NULL AND p_period_end IS NOT NULL THEN
      SELECT count(*) INTO v_count
        FROM timesheet_submissions ts
       WHERE ts.employee_id = p_subject_id
         AND ts.organization_id = p_org_id
         AND ts.period_start <= p_period_end
         AND ts.period_end   >= p_period_start
         AND ts.status <> 'approved';
      IF v_count > 0 THEN
        v_status := 'fail';
        v_reason := 'Timesheet-driven contract has unapproved timesheets in the period.';
        v_missing := ARRAY['timesheets_approved'];
        v_details := jsonb_build_object('unapproved_count', v_count);
      END IF;
    END IF;

  WHEN 'employee.statutory_leave_initialized' THEN
    SELECT string_agg(lt.code, ', ' ORDER BY lt.code) INTO v_missing_leave
      FROM leave_types lt
     WHERE lt.organization_id = p_org_id
       AND lt.is_statutory = true
       AND (p_business_id IS NULL OR lt.business_id IS NULL OR lt.business_id = p_business_id)
       AND NOT EXISTS (
         SELECT 1 FROM leave_allocations la
          WHERE la.employee_id = p_subject_id
            AND la.leave_type_id = lt.id
            AND la.year = EXTRACT(YEAR FROM COALESCE(p_period_start, CURRENT_DATE))::int
       );
    IF v_missing_leave IS NOT NULL AND length(v_missing_leave) > 0 THEN
      v_status := 'warn';
      v_reason := 'Statutory leave types have no current-year allocation: ' || v_missing_leave;
      v_missing := ARRAY['leave_allocations'];
      v_details := jsonb_build_object('missing_codes', v_missing_leave);
    END IF;

  WHEN 'run.period_not_closed' THEN
    IF EXISTS (
      SELECT 1 FROM payroll_runs pr
      JOIN fiscal_periods fp ON fp.organization_id = pr.organization_id
        AND fp.status = 'closed'
        AND pr.period_start BETWEEN fp.start_date AND fp.end_date
      WHERE pr.id = p_subject_id
    ) THEN
      v_status := 'fail'; v_reason := 'Payroll period falls inside a closed fiscal period.';
      v_missing := ARRAY['fiscal_period_open'];
    END IF;

  WHEN 'run.no_duplicate_regular' THEN
    SELECT count(*) INTO v_count
      FROM payroll_runs pr
     WHERE pr.id <> p_subject_id AND pr.organization_id = p_org_id
       AND COALESCE(pr.run_type, 'regular') = 'regular'
       AND pr.status NOT IN ('cancelled','void')
       AND EXISTS (
         SELECT 1 FROM payroll_runs me
         WHERE me.id = p_subject_id
           AND me.period_start = pr.period_start
           AND me.period_end = pr.period_end
       );
    IF v_count > 0 THEN
      v_status := 'fail';
      v_reason := 'Another regular run already exists for this period.';
      v_missing := ARRAY['duplicate_run'];
      v_details := jsonb_build_object('conflicts', v_count);
    END IF;

  WHEN 'run.loan_skip_overrides_present' THEN
    SELECT count(*) INTO v_count
      FROM payroll_run_loan_skip_overrides o
     WHERE o.payroll_run_id = p_subject_id;
    IF v_count > 0 THEN
      v_status := 'warn';
      v_reason := v_count || ' loan repayment skip override(s) recorded for this run — review before posting.';
      v_missing := ARRAY['loan_skip_overrides'];
      v_details := jsonb_build_object('skip_count', v_count);
    END IF;

  ELSE
    IF p_rule.predicate_sql IS NOT NULL AND length(trim(p_rule.predicate_sql)) > 0 THEN
      DECLARE v_ok boolean;
      BEGIN
        EXECUTE p_rule.predicate_sql INTO v_ok
          USING p_org_id, p_business_id, p_subject_id, p_period_start, p_period_end;
        IF NOT COALESCE(v_ok, false) THEN
          v_status := 'fail';
          v_reason := COALESCE(p_rule.description, p_rule.name);
          v_missing := ARRAY[p_rule.reason_code];
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_status := 'fail';
        v_reason := 'Readiness predicate raised: ' || SQLERRM;
        v_details := jsonb_build_object('sqlerrm', SQLERRM, 'sqlstate', SQLSTATE);
      END;
    ELSE
      v_status := 'skip';
      v_reason := 'Unknown check_kind and no predicate_sql; rule skipped.';
    END IF;
  END CASE;

  IF v_status = 'fail' AND p_rule.severity = 'warn' THEN
    v_status := 'warn';
  END IF;

  RETURN QUERY SELECT v_status, v_reason, v_missing, v_details;
END;
$function$;

-- 3. Seed the four new rules (idempotent on code)
INSERT INTO public.payroll_readiness_rules
  (organization_id, pack_id, code, name, description, scope, severity, source, reason_code, check_kind, remediation_label, remediation_link, sort_order)
VALUES
  (NULL, NULL, 'employee.exit_clearance_cleared',
   'Exit clearance has no blocking items',
   'Employees with an open exit clearance must have all blocking items cleared before payroll can run.',
   'employee', 'block', 'core', 'EMP_EXIT_CLEARANCE_OPEN', 'employee.exit_clearance_cleared',
   'Review exit clearance', '/hr/exits', 210),
  (NULL, NULL, 'employee.timesheets_approved',
   'Timesheets approved for the period',
   'Employees on timesheet-driven contracts must have all timesheets in the pay period approved.',
   'employee', 'block', 'core', 'EMP_TIMESHEETS_UNAPPROVED', 'employee.timesheets_approved',
   'Approve timesheets', '/hr/timesheets', 220),
  (NULL, NULL, 'employee.statutory_leave_initialized',
   'Statutory leave entitlements initialized',
   'Each statutory leave type should have a current-year allocation for the employee.',
   'employee', 'warn', 'core', 'EMP_STATUTORY_LEAVE_MISSING', 'employee.statutory_leave_initialized',
   'Initialize leave entitlements', '/hr/leave/allocations', 230),
  (NULL, NULL, 'run.loan_skip_overrides_present',
   'Loan repayment skip overrides review',
   'Loan repayment skip overrides recorded for this run should be reviewed before posting.',
   'run', 'warn', 'core', 'RUN_LOAN_SKIP_OVERRIDES', 'run.loan_skip_overrides_present',
   'Review skip overrides', NULL, 230)
ON CONFLICT DO NOTHING;
