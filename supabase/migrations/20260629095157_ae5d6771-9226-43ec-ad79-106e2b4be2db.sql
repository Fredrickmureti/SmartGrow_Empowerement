-- Phase A: period-effective evaluation + employee matrix + period employees lookup.

-- 1) Period-effective rule evaluator.
CREATE OR REPLACE FUNCTION public.payroll_readiness_eval_rule(
  p_rule         public.payroll_readiness_rules,
  p_org_id       uuid,
  p_business_id  uuid,
  p_subject_id   uuid,
  p_period_start date,
  p_period_end   date
)
RETURNS TABLE(status text, reason text, missing_fields text[], details jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status     text := 'pass';
  v_reason     text;
  v_missing    text[] := ARRAY[]::text[];
  v_details    jsonb := '{}'::jsonb;
  v_invalid    text;
  v_c          public.employee_contracts;
  v_components jsonb;
  v_p_start    date := COALESCE(p_period_start, CURRENT_DATE);
  v_p_end      date := COALESCE(p_period_end,   CURRENT_DATE);
BEGIN
  CASE p_rule.check_kind

  WHEN 'org.localization_pack_installed' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.installed_localization_packs ilp
      WHERE ilp.organization_id = p_org_id
    ) THEN
      v_status := 'fail'; v_reason := 'No localization pack installed for this organization.';
      v_missing := ARRAY['localization_pack'];
    END IF;

  WHEN 'org.salary_structure_active' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.salary_structures ss
      WHERE ss.organization_id = p_org_id AND ss.is_active = true
    ) THEN
      v_status := 'fail'; v_reason := 'No active salary structure has been defined org-wide.';
      v_missing := ARRAY['salary_structure'];
    END IF;

  WHEN 'org.payroll_accounts_mapped' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.default_account_settings das
      WHERE das.organization_id = p_org_id
        AND das.account_id IS NOT NULL
        AND (p_business_id IS NULL OR das.business_id IS NULL OR das.business_id = p_business_id)
    ) THEN
      v_status := 'fail'; v_reason := 'Payroll GL accounts have not been mapped.';
      v_missing := ARRAY['payroll_gl_accounts'];
    END IF;

  WHEN 'org.statutory_rules_active' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.payroll_statutory_rules psr
      WHERE psr.organization_id = p_org_id AND psr.is_active = true
        AND (psr.effective_to IS NULL OR psr.effective_to >= v_p_end)
    ) THEN
      v_status := 'fail'; v_reason := 'No active statutory rules in effect for the period.';
      v_missing := ARRAY['statutory_rules'];
    END IF;

  WHEN 'org.statutory_rules_valid_method' THEN
    SELECT string_agg(psr.rule_name, ', ' ORDER BY psr.rule_name) INTO v_invalid
    FROM public.payroll_statutory_rules psr
    WHERE psr.organization_id = p_org_id AND psr.is_active = true
      AND (psr.effective_to IS NULL OR psr.effective_to >= v_p_end)
      AND (psr.computation_method IS NULL
           OR lower(trim(psr.computation_method)) IN ('','unknown','auto'));
    IF v_invalid IS NOT NULL AND length(v_invalid) > 0 THEN
      v_status := 'fail'; v_reason := 'Statutory rules with invalid computation_method: ' || v_invalid;
      v_missing := ARRAY['statutory_rule_method'];
      v_details := jsonb_build_object('invalid_rules', v_invalid);
    END IF;

  WHEN 'org.payroll_period_exists' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.payroll_periods pp
      WHERE pp.organization_id = p_org_id
        AND (p_business_id IS NULL OR pp.business_id = p_business_id)
    ) THEN
      v_status := 'fail'; v_reason := 'No payroll periods generated yet.';
      v_missing := ARRAY['payroll_periods'];
    END IF;

  -- Period-effective contract presence: any contract overlapping the period.
  WHEN 'employee.active_contract' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id
       AND ec.status IN ('running','new','active')
       AND COALESCE(ec.start_date, v_p_start) <= v_p_end
       AND (ec.end_date IS NULL OR ec.end_date >= v_p_start)
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail';
      v_reason := 'No contract effective for the selected period.';
      v_missing := ARRAY['active_contract'];
    END IF;

  WHEN 'employee.contract_has_salary' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id
       AND ec.status IN ('running','new','active')
       AND COALESCE(ec.start_date, v_p_start) <= v_p_end
       AND (ec.end_date IS NULL OR ec.end_date >= v_p_start)
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail'; v_reason := 'No contract effective for the selected period.';
      v_missing := ARRAY['active_contract'];
    ELSIF COALESCE(v_c.wage, 0) <= 0 AND v_c.salary_structure_id IS NULL THEN
      v_status := 'fail'; v_reason := 'Active contract has neither a wage nor a salary structure.';
      v_missing := ARRAY['contract_wage'];
    END IF;

  WHEN 'employee.contract_has_schedule' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id
       AND ec.status IN ('running','new','active')
       AND COALESCE(ec.start_date, v_p_start) <= v_p_end
       AND (ec.end_date IS NULL OR ec.end_date >= v_p_start)
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail'; v_reason := 'No contract effective for the selected period.';
      v_missing := ARRAY['active_contract'];
    ELSIF v_c.working_schedule IS NULL OR btrim(v_c.working_schedule) = '' THEN
      v_status := 'fail'; v_reason := 'Active contract has no working schedule.';
      v_missing := ARRAY['work_schedule'];
    END IF;

  WHEN 'employee.compensation_mode_set' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id
       AND ec.status IN ('running','new','active')
       AND COALESCE(ec.start_date, v_p_start) <= v_p_end
       AND (ec.end_date IS NULL OR ec.end_date >= v_p_start)
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail'; v_reason := 'No contract effective for the selected period.';
      v_missing := ARRAY['active_contract'];
    ELSIF v_c.compensation_mode IS NULL THEN
      v_status := 'fail'; v_reason := 'Contract has no compensation method (structure or simple wage).';
      v_missing := ARRAY['compensation_mode'];
    END IF;

  WHEN 'employee.salary_structure_resolves' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id
       AND ec.status IN ('running','new','active')
       AND COALESCE(ec.start_date, v_p_start) <= v_p_end
       AND (ec.end_date IS NULL OR ec.end_date >= v_p_start)
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail'; v_reason := 'No contract effective for the selected period.';
      v_missing := ARRAY['active_contract'];
    ELSIF v_c.compensation_mode = 'structure' THEN
      IF v_c.salary_structure_id IS NULL THEN
        v_status := 'fail'; v_reason := 'Structure-mode contract has no salary structure selected.';
        v_missing := ARRAY['salary_structure_id'];
      ELSIF NOT EXISTS (
        SELECT 1 FROM public.salary_structures ss
        WHERE ss.id = v_c.salary_structure_id AND ss.is_active = true
      ) THEN
        v_status := 'fail'; v_reason := 'Selected salary structure is inactive.';
        v_missing := ARRAY['salary_structure_active'];
      ELSE
        SELECT public.canonicalise_salary_components(v_c.salary_structure_id) INTO v_components;
        IF COALESCE(v_components, '[]'::jsonb) = '[]'::jsonb THEN
          v_status := 'fail'; v_reason := 'Selected salary structure has no active components.';
          v_missing := ARRAY['salary_components'];
        END IF;
      END IF;
    END IF;

  ELSE
    NULL;
  END CASE;

  RETURN QUERY SELECT v_status, v_reason, v_missing, v_details;
END;
$function$;

-- 2) Period employees: who is in scope for a payroll period.
CREATE OR REPLACE FUNCTION public.payroll_period_employees(
  p_org_id       uuid,
  p_business_id  uuid DEFAULT NULL,
  p_period_start date DEFAULT NULL,
  p_period_end   date DEFAULT NULL
)
RETURNS TABLE (
  employee_id     uuid,
  first_name      text,
  last_name       text,
  employee_number text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH bounds AS (
    SELECT COALESCE(p_period_start, CURRENT_DATE) AS ps,
           COALESCE(p_period_end,   CURRENT_DATE) AS pe
  )
  SELECT DISTINCT e.id, e.first_name, e.last_name, e.employee_number
  FROM public.employees e
  JOIN public.employments em ON em.employee_id = e.id
  CROSS JOIN bounds b
  WHERE e.organization_id = p_org_id
    AND (p_business_id IS NULL OR e.business_id = p_business_id)
    AND COALESCE(em.start_date, b.ps) <= b.pe
    AND (em.end_date IS NULL OR em.end_date >= b.ps)
    AND COALESCE(em.status, 'active') NOT IN ('cancelled','void')
  ORDER BY e.first_name NULLS LAST, e.last_name NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_period_employees(uuid,uuid,date,date) TO authenticated, service_role;

-- 3) Employee matrix: full per-(employee, rule) status for UI consumption.
CREATE OR REPLACE FUNCTION public.payroll_readiness_employee_matrix(
  p_org_id       uuid,
  p_business_id  uuid DEFAULT NULL,
  p_employee_ids uuid[] DEFAULT NULL,
  p_period_start date DEFAULT NULL,
  p_period_end   date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ids        uuid[] := p_employee_ids;
  v_rules      jsonb;
  v_employees  jsonb;
BEGIN
  IF v_ids IS NULL THEN
    SELECT array_agg(employee_id) INTO v_ids
    FROM public.payroll_period_employees(p_org_id, p_business_id, p_period_start, p_period_end);
  END IF;

  -- Re-evaluate so we never read stale findings.
  IF v_ids IS NOT NULL AND array_length(v_ids, 1) IS NOT NULL THEN
    PERFORM public.evaluate_payroll_readiness(
      p_org_id, p_business_id, 'employee', v_ids, p_period_start, p_period_end
    );
  END IF;

  -- Rule catalog snapshot (employee scope).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'code',              r.code,
    'name',              r.name,
    'description',       r.description,
    'severity',          r.severity,
    'reason_code',       r.reason_code,
    'remediation_label', r.remediation_label,
    'remediation_link',  r.remediation_link,
    'sort_order',        r.sort_order,
    'prerequisite_rule_codes', r.prerequisite_rule_codes
  ) ORDER BY r.sort_order, r.code), '[]'::jsonb)
  INTO v_rules
  FROM public.payroll_readiness_rules r
  WHERE r.is_active = true
    AND r.scope = 'employee'
    AND (r.organization_id IS NULL OR r.organization_id = p_org_id);

  -- One row per employee, with a per-rule status map + structured findings.
  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    v_employees := '[]'::jsonb;
  ELSE
    SELECT COALESCE(jsonb_agg(row_data ORDER BY emp_name), '[]'::jsonb)
    INTO v_employees
    FROM (
      SELECT
        TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS emp_name,
        jsonb_build_object(
          'employee_id',     e.id,
          'first_name',      e.first_name,
          'last_name',       e.last_name,
          'employee_number', e.employee_number,
          'rule_status',     COALESCE(rs.statuses, '{}'::jsonb),
          'findings',        COALESCE(rs.findings, '[]'::jsonb),
          'blockers_count',  COALESCE(rs.blockers_count, 0),
          'warnings_count',  COALESCE(rs.warnings_count, 0),
          'na_count',        COALESCE(rs.na_count, 0),
          'pass_count',      COALESCE(rs.pass_count, 0),
          'is_ready',        COALESCE(rs.blockers_count, 0) = 0
        ) AS row_data
      FROM public.employees e
      LEFT JOIN LATERAL (
        SELECT
          jsonb_object_agg(r.code, f.status) AS statuses,
          jsonb_agg(jsonb_build_object(
            'rule_code',         r.code,
            'rule_name',         r.name,
            'severity',          r.severity,
            'status',            f.status,
            'reason',            COALESCE(f.reason, r.description, r.name),
            'reason_code',       r.reason_code,
            'missing_fields',    f.missing_fields,
            'remediation_label', r.remediation_label,
            'remediation_link',  r.remediation_link,
            'details',           f.details
          ) ORDER BY r.sort_order, r.code) AS findings,
          count(*) FILTER (WHERE f.status = 'fail' AND r.severity = 'block') AS blockers_count,
          count(*) FILTER (WHERE f.status = 'fail' AND r.severity = 'warn')  AS warnings_count,
          count(*) FILTER (WHERE f.status = 'na')                            AS na_count,
          count(*) FILTER (WHERE f.status = 'pass')                          AS pass_count
        FROM public.payroll_readiness_findings f
        JOIN public.payroll_readiness_rules r ON r.id = f.rule_id
        WHERE f.organization_id = p_org_id
          AND f.subject_type   = 'employee'
          AND f.subject_id     = e.id
          AND r.is_active      = true
          AND r.scope          = 'employee'
          AND (p_business_id IS NULL OR f.business_id IS NULL OR f.business_id = p_business_id)
      ) rs ON TRUE
      WHERE e.id = ANY (v_ids)
    ) src;
  END IF;

  RETURN jsonb_build_object(
    'rules',           v_rules,
    'employees',       v_employees,
    'period_start',    p_period_start,
    'period_end',      p_period_end,
    'evaluated_at',    now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_readiness_employee_matrix(uuid,uuid,uuid[],date,date) TO authenticated, service_role;