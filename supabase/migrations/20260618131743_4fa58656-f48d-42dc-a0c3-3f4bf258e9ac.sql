-- Unify payroll readiness: single summary RPC + structured assert variant.
-- Eliminates the contradictory state where the "Payroll Ready" badge
-- (org-scope only) can pass while compute-payroll's assert_payroll_ready
-- rejects the run for an employee-scope blocker.

-- ---------------------------------------------------------------------
-- 1. payroll_readiness_summary — single shape for badge + dialog + edge fn
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_readiness_summary(
  p_org_id       uuid,
  p_business_id  uuid DEFAULT NULL,
  p_employee_ids uuid[] DEFAULT NULL,
  p_period_start date DEFAULT NULL,
  p_period_end   date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_blockers      jsonb := '[]'::jsonb;
  v_business_blockers jsonb := '[]'::jsonb;
  v_employee_blockers jsonb := '[]'::jsonb;
  v_effective_ids     uuid[] := p_employee_ids;
  v_org_count int := 0;
  v_biz_count int := 0;
  v_emp_count int := 0;
BEGIN
  -- Default employee population: all active-contract employees in the business
  IF v_effective_ids IS NULL THEN
    SELECT array_agg(DISTINCT ec.employee_id) INTO v_effective_ids
    FROM employee_contracts ec
    WHERE ec.organization_id = p_org_id
      AND ec.status IN ('running','new','active')
      AND (p_business_id IS NULL OR ec.business_id = p_business_id);
  END IF;

  -- Re-evaluate org + business + employee scopes so we never read stale findings.
  PERFORM public.evaluate_payroll_readiness(p_org_id, p_business_id, 'org', NULL,
                                            p_period_start, p_period_end);
  IF p_business_id IS NOT NULL THEN
    BEGIN
      PERFORM public.evaluate_payroll_readiness(p_org_id, p_business_id, 'business',
                                                ARRAY[p_business_id]::uuid[],
                                                p_period_start, p_period_end);
    EXCEPTION WHEN OTHERS THEN
      -- 'business' scope is optional in the rules table; ignore if unsupported.
      NULL;
    END;
  END IF;
  IF v_effective_ids IS NOT NULL AND array_length(v_effective_ids, 1) IS NOT NULL THEN
    PERFORM public.evaluate_payroll_readiness(p_org_id, p_business_id, 'employee',
                                              v_effective_ids,
                                              p_period_start, p_period_end);
  END IF;

  -- Org blockers
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'scope',              'org',
    'subject_id',         NULL,
    'subject_label',      NULL,
    'rule_code',          b.rule_code,
    'rule_name',          b.rule_name,
    'reason',             b.reason,
    'reason_code',        b.reason_code,
    'remediation_label',  b.remediation_label,
    'remediation_link',   b.remediation_link,
    'missing_fields',     b.missing_fields,
    'severity',           'block'
  ) ORDER BY b.rule_code), '[]'::jsonb), count(*)
  INTO v_org_blockers, v_org_count
  FROM public.payroll_readiness_blockers(p_org_id, p_business_id, 'org', NULL) b;

  -- Business blockers (optional)
  IF p_business_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'scope',              'business',
      'subject_id',         p_business_id,
      'subject_label',      NULL,
      'rule_code',          b.rule_code,
      'rule_name',          b.rule_name,
      'reason',             b.reason,
      'reason_code',        b.reason_code,
      'remediation_label',  b.remediation_label,
      'remediation_link',   b.remediation_link,
      'missing_fields',     b.missing_fields,
      'severity',           'block'
    ) ORDER BY b.rule_code), '[]'::jsonb), count(*)
    INTO v_business_blockers, v_biz_count
    FROM public.payroll_readiness_blockers(p_org_id, p_business_id, 'business', p_business_id) b;
  END IF;

  -- Employee blockers — joined directly to findings so we get per-employee detail
  IF v_effective_ids IS NOT NULL AND array_length(v_effective_ids, 1) IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(row_data ORDER BY emp_name, rule_code), '[]'::jsonb),
           count(*)
    INTO v_employee_blockers, v_emp_count
    FROM (
      SELECT
        TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS emp_name,
        r.code AS rule_code,
        jsonb_build_object(
          'scope',              'employee',
          'subject_id',         f.subject_id,
          'subject_label',      TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,''))
                                 || COALESCE(' · ' || e.employee_number, ''),
          'rule_code',          r.code,
          'rule_name',          r.name,
          'reason',             COALESCE(f.reason, r.description, r.name),
          'reason_code',        r.reason_code,
          'remediation_label',  r.remediation_label,
          'remediation_link',   r.remediation_link,
          'missing_fields',     f.missing_fields,
          'severity',           r.severity
        ) AS row_data
      FROM payroll_readiness_findings f
      JOIN payroll_readiness_rules    r ON r.id = f.rule_id
      LEFT JOIN employees             e ON e.id = f.subject_id
      WHERE f.organization_id = p_org_id
        AND f.subject_type    = 'employee'
        AND f.subject_id      = ANY (v_effective_ids)
        AND f.status          = 'fail'
        AND r.severity        = 'block'
        AND r.is_active       = true
        AND (p_business_id IS NULL OR f.business_id IS NULL OR f.business_id = p_business_id)
    ) src;
  END IF;

  RETURN jsonb_build_object(
    'is_ready',           (v_org_count + v_biz_count + v_emp_count) = 0,
    'org_blockers',       v_org_blockers,
    'business_blockers',  v_business_blockers,
    'employee_blockers',  v_employee_blockers,
    'counts', jsonb_build_object(
      'org',      v_org_count,
      'business', v_biz_count,
      'employee', v_emp_count,
      'employees_evaluated', COALESCE(array_length(v_effective_ids, 1), 0)
    ),
    'evaluated_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_readiness_summary(uuid, uuid, uuid[], date, date)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. assert_payroll_ready_json — structured variant for edge functions
--    Same evaluation as assert_payroll_ready but returns JSONB instead
--    of raising SETUP_REQUIRED. The raising variant is kept for legacy
--    callers (and re-uses this function under the hood).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_payroll_ready_json(
  p_org_id       uuid,
  p_business_id  uuid DEFAULT NULL,
  p_employee_ids uuid[] DEFAULT NULL,
  p_period_start date DEFAULT NULL,
  p_period_end   date DEFAULT NULL,
  p_run_id       uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_summary jsonb;
  v_run_blockers jsonb := '[]'::jsonb;
  v_run_count int := 0;
BEGIN
  v_summary := public.payroll_readiness_summary(
    p_org_id, p_business_id, p_employee_ids, p_period_start, p_period_end
  );

  -- Add RUN scope when a run_id is supplied.
  IF p_run_id IS NOT NULL THEN
    PERFORM public.evaluate_payroll_readiness(p_org_id, p_business_id, 'run',
                                              ARRAY[p_run_id]::uuid[],
                                              p_period_start, p_period_end);
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'scope',              'run',
      'subject_id',         p_run_id,
      'subject_label',      NULL,
      'rule_code',          b.rule_code,
      'rule_name',          b.rule_name,
      'reason',             b.reason,
      'reason_code',        b.reason_code,
      'remediation_label',  b.remediation_label,
      'remediation_link',   b.remediation_link,
      'missing_fields',     b.missing_fields,
      'severity',           'block'
    ) ORDER BY b.rule_code), '[]'::jsonb), count(*)
    INTO v_run_blockers, v_run_count
    FROM public.payroll_readiness_blockers(p_org_id, p_business_id, 'run', p_run_id) b;
  END IF;

  RETURN jsonb_set(
    jsonb_set(v_summary, '{run_blockers}', v_run_blockers, true),
    '{is_ready}',
    to_jsonb(
      (v_summary->>'is_ready')::boolean AND v_run_count = 0
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_payroll_ready_json(uuid, uuid, uuid[], date, date, uuid)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Rewire the raising assert_payroll_ready to use the JSON variant.
--    Same behavior for legacy callers (raises SETUP_REQUIRED with the
--    concatenated reasons) but the evaluation now goes through the
--    single summary engine so badge + execution can never disagree.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_payroll_ready(
  p_org_id       uuid,
  p_business_id  uuid DEFAULT NULL,
  p_employee_ids uuid[] DEFAULT NULL,
  p_period_start date DEFAULT NULL,
  p_period_end   date DEFAULT NULL,
  p_run_id       uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payload jsonb;
  v_reasons text[] := ARRAY[]::text[];
  v_blocker jsonb;
  v_emp_count int;
BEGIN
  v_payload := public.assert_payroll_ready_json(
    p_org_id, p_business_id, p_employee_ids, p_period_start, p_period_end, p_run_id
  );

  IF (v_payload->>'is_ready')::boolean THEN
    RETURN true;
  END IF;

  -- Compose a single human-readable line per scope, matching the legacy
  -- SETUP_REQUIRED grammar so callers that still regex it keep working
  -- (Runs.tsx etc.) — though all UI callers should switch to the JSON variant.
  FOR v_blocker IN SELECT * FROM jsonb_array_elements(COALESCE(v_payload->'org_blockers', '[]'::jsonb))
  LOOP
    v_reasons := array_append(v_reasons,
      COALESCE(v_blocker->>'reason', v_blocker->>'reason_code', v_blocker->>'rule_code'));
  END LOOP;

  FOR v_blocker IN SELECT * FROM jsonb_array_elements(COALESCE(v_payload->'business_blockers', '[]'::jsonb))
  LOOP
    v_reasons := array_append(v_reasons,
      COALESCE(v_blocker->>'reason', v_blocker->>'reason_code', v_blocker->>'rule_code'));
  END LOOP;

  v_emp_count := COALESCE((v_payload#>'{counts,employee}')::int, 0);
  IF v_emp_count > 0 THEN
    v_reasons := array_append(v_reasons,
      v_emp_count || ' selected employee(s) failing readiness checks');
  END IF;

  FOR v_blocker IN SELECT * FROM jsonb_array_elements(COALESCE(v_payload->'run_blockers', '[]'::jsonb))
  LOOP
    v_reasons := array_append(v_reasons,
      COALESCE(v_blocker->>'reason', v_blocker->>'reason_code', v_blocker->>'rule_code'));
  END LOOP;

  IF array_length(v_reasons, 1) IS NULL THEN
    -- Defensive: is_ready=false but no reasons collected — surface a sentinel.
    v_reasons := ARRAY['payroll readiness evaluation failed without a specific reason'];
  END IF;

  RAISE EXCEPTION 'SETUP_REQUIRED: Payroll cannot run yet. Missing: %.',
    array_to_string(v_reasons, ', ')
    USING ERRCODE = 'P0001', HINT = 'payroll_setup_incomplete';
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_payroll_ready(uuid, uuid, uuid[], date, date, uuid)
  TO authenticated, service_role;