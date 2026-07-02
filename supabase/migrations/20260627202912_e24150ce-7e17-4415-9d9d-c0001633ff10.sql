-- =====================================================================
-- HR → Payroll lifecycle: compensation as first-class contract state
-- =====================================================================

-- 1. compensation_mode column on employee_contracts ---------------------
ALTER TABLE public.employee_contracts
  ADD COLUMN IF NOT EXISTS compensation_mode text;

-- Backfill from existing data (idempotent)
UPDATE public.employee_contracts
   SET compensation_mode = CASE
     WHEN salary_structure_id IS NOT NULL THEN 'structure'
     WHEN COALESCE(wage, 0) > 0           THEN 'flat_wage'
     ELSE NULL
   END
 WHERE compensation_mode IS NULL;

-- CHECK-style integrity enforced via trigger (CHECK must be immutable;
-- we want to allow future modes without ALTER TABLE).
CREATE OR REPLACE FUNCTION public.enforce_contract_compensation_mode_shape()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.compensation_mode IS NOT NULL
     AND NEW.compensation_mode NOT IN ('structure','flat_wage') THEN
    RAISE EXCEPTION 'invalid compensation_mode: %', NEW.compensation_mode
      USING ERRCODE = '22023';
  END IF;
  -- structure mode requires structure id; flat_wage forbids it
  IF NEW.compensation_mode = 'structure' AND NEW.salary_structure_id IS NULL THEN
    NULL; -- allowed transiently during edit; readiness/activation gate catches it
  END IF;
  IF NEW.compensation_mode = 'flat_wage' AND NEW.salary_structure_id IS NOT NULL THEN
    -- Auto-correct: a structure is selected, so mode is actually 'structure'.
    NEW.compensation_mode := 'structure';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ec_compensation_mode_shape ON public.employee_contracts;
CREATE TRIGGER trg_ec_compensation_mode_shape
  BEFORE INSERT OR UPDATE OF compensation_mode, salary_structure_id
  ON public.employee_contracts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_contract_compensation_mode_shape();

COMMENT ON COLUMN public.employee_contracts.compensation_mode IS
  'How this contract supplies compensation to payroll: ''structure'' (use salary_structure_id components) or ''flat_wage'' (use wage + allowance columns). NULL means unconfigured and will be flagged by payroll readiness.';

-- 2. assert_contract_compensation_ready --------------------------------
CREATE OR REPLACE FUNCTION public.assert_contract_compensation_ready(p_contract_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_c           public.employee_contracts;
  v_blockers    jsonb := '[]'::jsonb;
  v_components  jsonb;
  v_struct_ok   boolean;
BEGIN
  SELECT * INTO v_c FROM public.employee_contracts WHERE id = p_contract_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'is_ready', false,
      'blockers', jsonb_build_array(jsonb_build_object(
        'code','contract.not_found','reason','Contract not found.'))
    );
  END IF;

  -- Compensation mode resolved
  IF v_c.compensation_mode IS NULL THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code','contract.compensation_mode_missing',
      'reason','Compensation method (salary structure or simple wage) is not set.',
      'remediation_label','Configure compensation',
      'remediation_link','/hr/employees');
  END IF;

  -- Structure mode: structure must exist, be active, and have components
  IF v_c.compensation_mode = 'structure' THEN
    IF v_c.salary_structure_id IS NULL THEN
      v_blockers := v_blockers || jsonb_build_object(
        'code','contract.salary_structure_missing',
        'reason','Contract is set to use a salary structure but none is selected.',
        'remediation_label','Select salary structure',
        'remediation_link','/hr/employees');
    ELSE
      SELECT public.canonicalise_salary_components(v_c.salary_structure_id) INTO v_components;
      v_struct_ok := EXISTS (
        SELECT 1 FROM public.salary_structures
         WHERE id = v_c.salary_structure_id AND is_active = true
      );
      IF NOT v_struct_ok THEN
        v_blockers := v_blockers || jsonb_build_object(
          'code','contract.salary_structure_inactive',
          'reason','Selected salary structure is inactive.',
          'remediation_label','Choose an active structure',
          'remediation_link','/hr/payroll/configuration/structures');
      ELSIF COALESCE(v_components, '[]'::jsonb) = '[]'::jsonb THEN
        v_blockers := v_blockers || jsonb_build_object(
          'code','contract.salary_structure_empty',
          'reason','Selected salary structure has no active components.',
          'remediation_label','Add structure components',
          'remediation_link','/hr/payroll/configuration/structures');
      END IF;
    END IF;
  END IF;

  -- Flat wage mode: wage > 0
  IF v_c.compensation_mode = 'flat_wage' AND COALESCE(v_c.wage, 0) <= 0 THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code','contract.flat_wage_zero',
      'reason','Simple-wage contract must specify a wage greater than zero.',
      'remediation_label','Set wage',
      'remediation_link','/hr/employees');
  END IF;

  -- Working schedule
  IF v_c.work_schedule_id IS NULL THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code','contract.work_schedule_missing',
      'reason','Contract has no working schedule assigned.',
      'remediation_label','Assign working schedule',
      'remediation_link','/hr/employees');
  END IF;

  RETURN jsonb_build_object(
    'is_ready', jsonb_array_length(v_blockers) = 0,
    'contract_id', p_contract_id,
    'employee_id', v_c.employee_id,
    'blockers', v_blockers
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_contract_compensation_ready(uuid)
  TO authenticated, service_role;

-- 3. Activation gate trigger ------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_contract_compensation_on_activation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_result jsonb;
  v_bypass boolean;
BEGIN
  -- Respect existing teardown/bypass context used by sibling HR guards
  BEGIN
    v_bypass := COALESCE(current_setting('app.bypass_hr_guards', true), '') = 'on'
             OR COALESCE(current_setting('app.teardown_in_progress', true), '') = 'on';
  EXCEPTION WHEN OTHERS THEN
    v_bypass := false;
  END;
  IF v_bypass THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'running' AND COALESCE(OLD.status,'') <> 'running' THEN
    v_result := public.assert_contract_compensation_ready(NEW.id);
    IF (v_result->>'is_ready')::boolean = false THEN
      RAISE EXCEPTION 'CONTRACT_COMPENSATION_INCOMPLETE: %', v_result::text
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ec_compensation_activation_gate ON public.employee_contracts;
CREATE TRIGGER trg_ec_compensation_activation_gate
  BEFORE UPDATE OF status ON public.employee_contracts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_contract_compensation_on_activation();

-- 4. Payroll readiness rule swap --------------------------------------
-- Downgrade the org-wide rule from block to warn (single-employee orgs
-- and flat-wage-only orgs should not be hard-blocked).
UPDATE public.payroll_readiness_rules
   SET severity = 'warn',
       description = 'Recommended: at least one active salary structure org-wide so new hires default to a structured compensation model.'
 WHERE organization_id IS NULL
   AND code = 'org.salary_structure_active';

-- Add new per-employee blockers
INSERT INTO public.payroll_readiness_rules
  (organization_id, code, name, description, scope, severity, source, reason_code, check_kind, remediation_label, remediation_link, sort_order)
VALUES
  (NULL,
   'employee.compensation_mode_set',
   'Compensation method set',
   'Each employee on the run must have an active contract with a compensation method (salary structure or simple wage).',
   'employee', 'block', 'core', 'EMP_NO_COMP_MODE',
   'employee.compensation_mode_set',
   'Configure contract compensation', '/hr/employees', 122),
  (NULL,
   'employee.salary_structure_resolves',
   'Salary structure resolves',
   'Structure-mode contracts must reference an active salary structure with at least one component.',
   'employee', 'block', 'core', 'EMP_STRUCT_UNRESOLVED',
   'employee.salary_structure_resolves',
   'Fix salary structure', '/hr/payroll/configuration/structures', 124)
ON CONFLICT (organization_id, code) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      severity = EXCLUDED.severity,
      remediation_label = EXCLUDED.remediation_label,
      remediation_link  = EXCLUDED.remediation_link,
      sort_order = EXCLUDED.sort_order;

-- 5. Extend the rule evaluator with the new check_kinds ---------------
-- We can't easily ALTER the existing CASE inside payroll_readiness_eval_rule
-- without re-creating it, but adding cases requires the full body. We
-- instead create a thin extension function and call it from the existing
-- evaluator when status is still 'pass'. Patch evaluator to defer unknown
-- kinds to the extension.

CREATE OR REPLACE FUNCTION public.payroll_readiness_eval_rule_ext(
  p_rule          public.payroll_readiness_rules,
  p_org_id        uuid,
  p_business_id   uuid,
  p_subject_id    uuid,
  p_period_start  date,
  p_period_end    date
) RETURNS TABLE (status text, reason text, missing_fields text[], details jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status   text := 'pass';
  v_reason   text;
  v_missing  text[] := ARRAY[]::text[];
  v_details  jsonb := '{}'::jsonb;
  v_c        public.employee_contracts;
  v_components jsonb;
BEGIN
  CASE p_rule.check_kind

  WHEN 'employee.compensation_mode_set' THEN
    SELECT * INTO v_c
      FROM public.employee_contracts
     WHERE employee_id = p_subject_id
       AND status = 'running'
     ORDER BY start_date DESC NULLS LAST
     LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail';
      v_reason := 'No active contract for employee.';
      v_missing := ARRAY['contract'];
    ELSIF v_c.compensation_mode IS NULL THEN
      v_status := 'fail';
      v_reason := 'Contract has no compensation method (structure or simple wage).';
      v_missing := ARRAY['compensation_mode'];
    END IF;

  WHEN 'employee.salary_structure_resolves' THEN
    SELECT * INTO v_c
      FROM public.employee_contracts
     WHERE employee_id = p_subject_id
       AND status = 'running'
     ORDER BY start_date DESC NULLS LAST
     LIMIT 1;
    IF FOUND AND v_c.compensation_mode = 'structure' THEN
      IF v_c.salary_structure_id IS NULL THEN
        v_status := 'fail';
        v_reason := 'Structure-mode contract has no salary structure selected.';
        v_missing := ARRAY['salary_structure_id'];
      ELSIF NOT EXISTS (
        SELECT 1 FROM public.salary_structures
         WHERE id = v_c.salary_structure_id AND is_active = true
      ) THEN
        v_status := 'fail';
        v_reason := 'Selected salary structure is inactive.';
        v_missing := ARRAY['salary_structure_active'];
      ELSE
        SELECT public.canonicalise_salary_components(v_c.salary_structure_id) INTO v_components;
        IF COALESCE(v_components, '[]'::jsonb) = '[]'::jsonb THEN
          v_status := 'fail';
          v_reason := 'Selected salary structure has no active components.';
          v_missing := ARRAY['salary_components'];
        END IF;
      END IF;
    END IF;

  ELSE
    -- Unknown to extension: leave pass; the base evaluator handled it.
    NULL;
  END CASE;

  RETURN QUERY SELECT v_status, v_reason, v_missing, v_details;
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_readiness_eval_rule_ext(
  public.payroll_readiness_rules, uuid, uuid, uuid, date, date
) TO authenticated, service_role;

-- Wrap the base evaluator: if base returns 'pass' on a kind it doesn't
-- recognise (which it does — its CASE has no ELSE so non-matching kinds
-- fall through with v_status='pass'), call the extension to evaluate the
-- new kinds. The cleanest approach is to update the unified summary RPC
-- to call both, but doing it in the eval_rule itself preserves all
-- existing callers.

CREATE OR REPLACE FUNCTION public.payroll_readiness_eval_rule(
  p_rule          public.payroll_readiness_rules,
  p_org_id        uuid,
  p_business_id   uuid,
  p_subject_id    uuid,
  p_period_start  date,
  p_period_end    date
) RETURNS TABLE (status text, reason text, missing_fields text[], details jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status   text := 'pass';
  v_reason   text;
  v_missing  text[] := ARRAY[]::text[];
  v_details  jsonb := '{}'::jsonb;
  v_invalid  text;
  v_c        public.employee_contracts;
  v_components jsonb;
BEGIN
  CASE p_rule.check_kind

  WHEN 'org.localization_pack_installed' THEN
    IF NOT EXISTS (SELECT 1 FROM installed_localization_packs WHERE organization_id = p_org_id) THEN
      v_status := 'fail'; v_reason := 'No localization pack installed for this organization.';
      v_missing := ARRAY['localization_pack'];
    END IF;

  WHEN 'org.salary_structure_active' THEN
    IF NOT EXISTS (SELECT 1 FROM salary_structures WHERE organization_id = p_org_id AND is_active = true) THEN
      v_status := 'fail'; v_reason := 'No active salary structure has been defined org-wide.';
      v_missing := ARRAY['salary_structure'];
    END IF;

  WHEN 'org.payroll_accounts_mapped' THEN
    IF NOT EXISTS (
      SELECT 1 FROM default_account_settings
      WHERE organization_id = p_org_id
        AND account_id IS NOT NULL
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
      v_status := 'fail'; v_reason := 'Statutory rules with invalid computation_method: ' || v_invalid;
      v_missing := ARRAY['statutory_rule_method'];
      v_details := jsonb_build_object('invalid_rules', v_invalid);
    END IF;

  WHEN 'org.payroll_period_exists' THEN
    IF NOT EXISTS (
      SELECT 1 FROM payroll_periods
       WHERE organization_id = p_org_id
         AND (p_business_id IS NULL OR business_id = p_business_id)
    ) THEN
      v_status := 'fail'; v_reason := 'No payroll periods generated yet.';
      v_missing := ARRAY['payroll_periods'];
    END IF;

  WHEN 'employee.active_contract' THEN
    IF NOT EXISTS (
      SELECT 1 FROM employee_contracts
       WHERE employee_id = p_subject_id AND status = 'running'
    ) THEN
      v_status := 'fail'; v_reason := 'No active (running) contract for this employee.';
      v_missing := ARRAY['active_contract'];
    END IF;

  WHEN 'employee.contract_has_salary' THEN
    SELECT * INTO v_c FROM employee_contracts
     WHERE employee_id = p_subject_id AND status='running'
     ORDER BY start_date DESC NULLS LAST LIMIT 1;
    IF FOUND AND COALESCE(v_c.wage, 0) <= 0 AND v_c.salary_structure_id IS NULL THEN
      v_status := 'fail'; v_reason := 'Active contract has neither a wage nor a salary structure.';
      v_missing := ARRAY['contract_wage'];
    END IF;

  WHEN 'employee.contract_has_schedule' THEN
    SELECT * INTO v_c FROM employee_contracts
     WHERE employee_id = p_subject_id AND status='running'
     ORDER BY start_date DESC NULLS LAST LIMIT 1;
    IF FOUND AND v_c.work_schedule_id IS NULL THEN
      v_status := 'fail'; v_reason := 'Active contract has no working schedule.';
      v_missing := ARRAY['work_schedule'];
    END IF;

  WHEN 'employee.compensation_mode_set' THEN
    SELECT * INTO v_c FROM employee_contracts
     WHERE employee_id = p_subject_id AND status='running'
     ORDER BY start_date DESC NULLS LAST LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail'; v_reason := 'No active contract for employee.';
      v_missing := ARRAY['contract'];
    ELSIF v_c.compensation_mode IS NULL THEN
      v_status := 'fail'; v_reason := 'Contract has no compensation method (structure or simple wage).';
      v_missing := ARRAY['compensation_mode'];
    END IF;

  WHEN 'employee.salary_structure_resolves' THEN
    SELECT * INTO v_c FROM employee_contracts
     WHERE employee_id = p_subject_id AND status='running'
     ORDER BY start_date DESC NULLS LAST LIMIT 1;
    IF FOUND AND v_c.compensation_mode = 'structure' THEN
      IF v_c.salary_structure_id IS NULL THEN
        v_status := 'fail'; v_reason := 'Structure-mode contract has no salary structure selected.';
        v_missing := ARRAY['salary_structure_id'];
      ELSIF NOT EXISTS (SELECT 1 FROM salary_structures WHERE id = v_c.salary_structure_id AND is_active = true) THEN
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
$$;

GRANT EXECUTE ON FUNCTION public.payroll_readiness_eval_rule(
  public.payroll_readiness_rules, uuid, uuid, uuid, date, date
) TO authenticated, service_role;

-- 6. Statutory inputs view (rename clarification) ----------------------
CREATE OR REPLACE VIEW public.contract_statutory_inputs AS
  SELECT * FROM public.contract_compensation_components;

COMMENT ON VIEW public.contract_statutory_inputs IS
  'Stable alias for contract_compensation_components. This table holds statutory inputs (e.g. insurance_premium) consumed by payroll statutory rules — NOT salary composition. Salary composition lives in salary_structures + salary_components, linked via employee_contracts.salary_structure_id.';

GRANT SELECT ON public.contract_statutory_inputs TO authenticated;
GRANT ALL    ON public.contract_statutory_inputs TO service_role;