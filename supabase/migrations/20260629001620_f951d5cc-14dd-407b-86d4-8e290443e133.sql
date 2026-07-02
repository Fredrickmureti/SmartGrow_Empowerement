
-- 1) Add prerequisite_rule_codes to the rules catalog
ALTER TABLE public.payroll_readiness_rules
  ADD COLUMN IF NOT EXISTS prerequisite_rule_codes text[] NOT NULL DEFAULT '{}'::text[];

-- Seed dependency edges
UPDATE public.payroll_readiness_rules
   SET prerequisite_rule_codes = ARRAY['employee.active_contract']
 WHERE scope = 'employee'
   AND code IN (
     'employee.contract_has_salary',
     'employee.contract_has_schedule',
     'employee.compensation_mode_set',
     'employee.salary_structure_resolves',
     'employee.has_payment_info',
     'employee.has_statutory_identifiers',
     'core.employee.statutory_fields_required',
     'employee.statutory_leave_initialized',
     'employee.exit_clearance_cleared',
     'employee.timesheets_approved'
   );

UPDATE public.payroll_readiness_rules SET prerequisite_rule_codes = ARRAY['org.localization_pack_installed']
 WHERE code='org.statutory_rules_active';
UPDATE public.payroll_readiness_rules SET prerequisite_rule_codes = ARRAY['org.statutory_rules_active']
 WHERE code='org.statutory_rules_valid_method';
UPDATE public.payroll_readiness_rules SET prerequisite_rule_codes = ARRAY['org.localization_pack_installed']
 WHERE code='org.payroll_accounts_mapped';
UPDATE public.payroll_readiness_rules SET prerequisite_rule_codes = ARRAY['org.localization_pack_installed']
 WHERE code='org.payroll_period_exists';

-- 2) Recreate the per-rule evaluator with stable column names + default-fail
--    when the prerequisite contract is missing. We standardize on
--    (status, reason, missing_fields, details) so callers stop reading
--    out_* / status mismatches.
DROP FUNCTION IF EXISTS public.payroll_readiness_eval_rule(public.payroll_readiness_rules, uuid, uuid, uuid, date, date);

CREATE OR REPLACE FUNCTION public.payroll_readiness_eval_rule(
  p_rule public.payroll_readiness_rules,
  p_org_id uuid,
  p_business_id uuid,
  p_subject_id uuid,
  p_period_start date,
  p_period_end date
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
        AND (psr.effective_to IS NULL OR psr.effective_to >= COALESCE(p_period_end, CURRENT_DATE))
    ) THEN
      v_status := 'fail'; v_reason := 'No active statutory rules in effect for the period.';
      v_missing := ARRAY['statutory_rules'];
    END IF;

  WHEN 'org.statutory_rules_valid_method' THEN
    SELECT string_agg(psr.rule_name, ', ' ORDER BY psr.rule_name) INTO v_invalid
    FROM public.payroll_statutory_rules psr
    WHERE psr.organization_id = p_org_id AND psr.is_active = true
      AND (psr.effective_to IS NULL OR psr.effective_to >= COALESCE(p_period_end, CURRENT_DATE))
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

  WHEN 'employee.active_contract' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.employee_contracts ec
      WHERE ec.employee_id = p_subject_id AND ec.status = 'running'
    ) THEN
      v_status := 'fail'; v_reason := 'No active (running) contract for this employee.';
      v_missing := ARRAY['active_contract'];
    END IF;

  WHEN 'employee.contract_has_salary' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id AND ec.status = 'running'
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail'; v_reason := 'No active contract for employee.';
      v_missing := ARRAY['active_contract'];
    ELSIF COALESCE(v_c.wage, 0) <= 0 AND v_c.salary_structure_id IS NULL THEN
      v_status := 'fail'; v_reason := 'Active contract has neither a wage nor a salary structure.';
      v_missing := ARRAY['contract_wage'];
    END IF;

  WHEN 'employee.contract_has_schedule' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id AND ec.status = 'running'
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail'; v_reason := 'No active contract for employee.';
      v_missing := ARRAY['active_contract'];
    ELSIF v_c.working_schedule IS NULL OR btrim(v_c.working_schedule) = '' THEN
      v_status := 'fail'; v_reason := 'Active contract has no working schedule.';
      v_missing := ARRAY['work_schedule'];
    END IF;

  WHEN 'employee.compensation_mode_set' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id AND ec.status = 'running'
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail'; v_reason := 'No active contract for employee.';
      v_missing := ARRAY['active_contract'];
    ELSIF v_c.compensation_mode IS NULL THEN
      v_status := 'fail'; v_reason := 'Contract has no compensation method (structure or simple wage).';
      v_missing := ARRAY['compensation_mode'];
    END IF;

  WHEN 'employee.salary_structure_resolves' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id AND ec.status = 'running'
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail'; v_reason := 'No active contract for employee.';
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

-- 3) Recreate evaluate_payroll_readiness:
--    - Reads (status, reason, missing_fields, details) cleanly
--    - Honors prerequisite_rule_codes per-subject ⇒ writes status='na'
--      when a prerequisite did not pass instead of letting CASE fall
--      through and default to 'pass'.
CREATE OR REPLACE FUNCTION public.evaluate_payroll_readiness(
  p_org_id uuid,
  p_business_id uuid DEFAULT NULL,
  p_scope text DEFAULT 'org',
  p_subject_ids uuid[] DEFAULT NULL,
  p_period_start date DEFAULT NULL,
  p_period_end date DEFAULT NULL
)
RETURNS public.payroll_readiness_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_run public.payroll_readiness_runs;
  v_rule public.payroll_readiness_rules;
  v_subject uuid;
  v_subjects uuid[];
  v_eval record;
  v_pass int := 0;
  v_fail int := 0;
  v_warn int := 0;
  v_na   int := 0;
  v_prereq_status text;
  v_blocking_prereq text;
  v_eff_status text;
  v_eff_reason text;
  v_eff_missing text[];
  v_eff_details jsonb;
BEGIN
  INSERT INTO payroll_readiness_runs (organization_id, business_id, scope, triggered_by)
  VALUES (p_org_id, p_business_id, p_scope, auth.uid())
  RETURNING * INTO v_run;

  IF p_scope IN ('employee','run') THEN
    v_subjects := COALESCE(p_subject_ids, ARRAY[]::uuid[]);
  ELSE
    v_subjects := ARRAY[NULL::uuid];
  END IF;

  FOR v_rule IN
    SELECT * FROM payroll_readiness_rules
    WHERE is_active = true
      AND scope = p_scope
      AND (organization_id IS NULL OR organization_id = p_org_id)
    ORDER BY sort_order, code
  LOOP
    FOREACH v_subject IN ARRAY v_subjects LOOP
      -- Stale-row cleanup for the same (org, subject, rule) under a different business.
      DELETE FROM payroll_readiness_findings
       WHERE organization_id = p_org_id
         AND subject_type    = p_scope
         AND subject_id IS NOT DISTINCT FROM v_subject
         AND rule_id         = v_rule.id
         AND business_id IS DISTINCT FROM p_business_id;

      -- Prerequisite gate: if any prereq for the same subject did NOT pass
      -- in this evaluation pass, short-circuit to 'na' and skip evaluation.
      v_blocking_prereq := NULL;
      IF v_rule.prerequisite_rule_codes IS NOT NULL
         AND array_length(v_rule.prerequisite_rule_codes, 1) > 0 THEN
        SELECT pr.code INTO v_blocking_prereq
          FROM payroll_readiness_findings pf
          JOIN payroll_readiness_rules pr ON pr.id = pf.rule_id
         WHERE pf.organization_id = p_org_id
           AND pf.business_id IS NOT DISTINCT FROM p_business_id
           AND pf.subject_type  = p_scope
           AND pf.subject_id IS NOT DISTINCT FROM v_subject
           AND pr.code = ANY(v_rule.prerequisite_rule_codes)
           AND pf.status <> 'pass'
         ORDER BY pr.sort_order, pr.code
         LIMIT 1;
      END IF;

      IF v_blocking_prereq IS NOT NULL THEN
        v_eff_status  := 'na';
        v_eff_reason  := 'Prerequisite ' || v_blocking_prereq || ' not satisfied.';
        v_eff_missing := ARRAY[]::text[];
        v_eff_details := jsonb_build_object('blocked_by', v_blocking_prereq);

        INSERT INTO payroll_readiness_findings (
          organization_id, business_id, rule_id, subject_type, subject_id,
          status, reason, missing_fields, details, evaluated_at
        ) VALUES (
          p_org_id, p_business_id, v_rule.id, p_scope, v_subject,
          v_eff_status, v_eff_reason, v_eff_missing, v_eff_details, now()
        )
        ON CONFLICT (
          organization_id,
          COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid),
          subject_type,
          COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'::uuid),
          rule_id
        )
        DO UPDATE SET
          status = EXCLUDED.status,
          reason = EXCLUDED.reason,
          missing_fields = EXCLUDED.missing_fields,
          details = EXCLUDED.details,
          evaluated_at = EXCLUDED.evaluated_at;

        v_na := v_na + 1;
        CONTINUE;
      END IF;

      FOR v_eval IN
        SELECT * FROM payroll_readiness_eval_rule(
          v_rule, p_org_id, p_business_id, v_subject, p_period_start, p_period_end
        )
      LOOP
        INSERT INTO payroll_readiness_findings (
          organization_id, business_id, rule_id, subject_type, subject_id,
          status, reason, missing_fields, details, evaluated_at
        ) VALUES (
          p_org_id, p_business_id, v_rule.id, p_scope, v_subject,
          v_eval.status, v_eval.reason, v_eval.missing_fields, v_eval.details, now()
        )
        ON CONFLICT (
          organization_id,
          COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid),
          subject_type,
          COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'::uuid),
          rule_id
        )
        DO UPDATE SET
          status = EXCLUDED.status,
          reason = EXCLUDED.reason,
          missing_fields = EXCLUDED.missing_fields,
          details = EXCLUDED.details,
          evaluated_at = EXCLUDED.evaluated_at;

        IF v_eval.status = 'pass' THEN v_pass := v_pass + 1;
        ELSIF v_eval.status = 'fail' THEN v_fail := v_fail + 1;
        ELSIF v_eval.status = 'warn' THEN v_warn := v_warn + 1;
        ELSIF v_eval.status = 'na'   THEN v_na   := v_na   + 1;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  PERFORM public.gc_payroll_readiness_findings(p_org_id);

  UPDATE payroll_readiness_runs
     SET finished_at = now(), pass_count = v_pass, fail_count = v_fail, warn_count = v_warn
   WHERE id = v_run.id
   RETURNING * INTO v_run;

  RETURN v_run;
END;
$function$;

-- 4) Purge stale findings so the page recomputes from the corrected engine.
DELETE FROM public.payroll_readiness_findings;

-- 5) Drop the legacy duplicate RPC (the unified summary supersedes it).
DROP FUNCTION IF EXISTS public.business_payroll_readiness(uuid);
