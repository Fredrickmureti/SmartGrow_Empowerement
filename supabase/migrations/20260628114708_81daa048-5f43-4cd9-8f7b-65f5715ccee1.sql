
-- Fix 1: assert_contract_compensation_ready — replace v_c.work_schedule_id with v_c.working_schedule
CREATE OR REPLACE FUNCTION public.assert_contract_compensation_ready(p_contract_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  IF v_c.compensation_mode IS NULL THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code','contract.compensation_mode_missing',
      'reason','Compensation method (salary structure or simple wage) is not set.',
      'remediation_label','Configure compensation',
      'remediation_link','/hr/employees');
  END IF;

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

  IF v_c.compensation_mode = 'flat_wage' AND COALESCE(v_c.wage, 0) <= 0 THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code','contract.flat_wage_zero',
      'reason','Simple-wage contract must specify a wage greater than zero.',
      'remediation_label','Set wage',
      'remediation_link','/hr/employees');
  END IF;

  -- Working schedule: the column is `working_schedule` (text) on employee_contracts.
  -- Previously this referenced a non-existent `work_schedule_id` and caused
  -- "record v_c has no field work_schedule_id" at runtime, blocking employee creation.
  IF v_c.working_schedule IS NULL OR btrim(v_c.working_schedule) = '' THEN
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
$function$;

-- Fix 2: payroll_readiness_eval_rule — same drift in the work-schedule branch.
-- We patch via a body-level regexp_replace to avoid having to redefine the entire
-- (long) function inline; the substitution is exact and idempotent.
DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='payroll_readiness_eval_rule'
  LIMIT 1;

  IF v_def IS NULL THEN
    RAISE NOTICE 'payroll_readiness_eval_rule not found; skipping patch';
    RETURN;
  END IF;

  v_new := replace(
    v_def,
    'v_c.work_schedule_id IS NULL',
    '(v_c.working_schedule IS NULL OR btrim(v_c.working_schedule) = '''')'
  );

  IF v_new = v_def THEN
    RAISE NOTICE 'payroll_readiness_eval_rule already patched';
  ELSE
    EXECUTE v_new;
  END IF;
END $$;
