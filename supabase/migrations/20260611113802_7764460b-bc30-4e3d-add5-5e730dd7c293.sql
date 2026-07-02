
-- ─── 1. One-shot cleanup: delete stale NULL-business_id findings that have a
--        newer same-rule finding under a real business_id. ───
DELETE FROM public.payroll_readiness_findings f_old
USING public.payroll_readiness_findings f_new
WHERE f_old.business_id IS NULL
  AND f_new.business_id IS NOT NULL
  AND f_old.organization_id = f_new.organization_id
  AND f_old.subject_type    = f_new.subject_type
  AND f_old.subject_id IS NOT DISTINCT FROM f_new.subject_id
  AND f_old.rule_id         = f_new.rule_id
  AND f_old.id <> f_new.id;

-- ─── 2. Harden evaluate_payroll_readiness: purge cross-business duplicates
--        for the same (org, subject_type, subject_id, rule) before inserting. ───
CREATE OR REPLACE FUNCTION public.evaluate_payroll_readiness(
  p_org_id uuid,
  p_business_id uuid DEFAULT NULL::uuid,
  p_scope text DEFAULT 'org'::text,
  p_subject_ids uuid[] DEFAULT NULL::uuid[],
  p_period_start date DEFAULT NULL::date,
  p_period_end date DEFAULT NULL::date
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
      -- Purge any pre-existing finding for the same (org, subject, rule) whose
      -- business_id differs from the one we're evaluating under. This prevents
      -- stale rows (e.g. recorded with NULL business_id before the workspace
      -- had a default business) from coexisting with the fresh result.
      DELETE FROM payroll_readiness_findings
       WHERE organization_id = p_org_id
         AND subject_type    = p_scope
         AND subject_id IS NOT DISTINCT FROM v_subject
         AND rule_id         = v_rule.id
         AND business_id IS DISTINCT FROM p_business_id;

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

-- ─── 3. Fix employee_payroll_readiness ambiguity (qualify every column). ───
CREATE OR REPLACE FUNCTION public.employee_payroll_readiness(p_employee_id uuid)
RETURNS TABLE(
  employee_id uuid,
  has_contract boolean,
  has_salary boolean,
  has_schedule boolean,
  has_bank boolean,
  required_identifier_keys text[],
  present_identifier_keys text[],
  missing_identifier_keys text[],
  is_ready boolean,
  blockers text[]
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_business_id uuid;
  v_today date := CURRENT_DATE;
  v_contract_id uuid;
  v_wage numeric;
  v_working_schedule jsonb;
  v_salary numeric := 0;
  v_required text[] := ARRAY[]::text[];
  v_present text[] := ARRAY[]::text[];
  v_missing text[] := ARRAY[]::text[];
  v_blockers text[] := ARRAY[]::text[];
  v_has_contract boolean := false;
  v_has_salary boolean := false;
  v_has_schedule boolean := false;
  v_has_bank boolean := false;
BEGIN
  SELECT e.business_id INTO v_business_id
  FROM public.employees e WHERE e.id = p_employee_id;
  IF v_business_id IS NULL THEN RETURN; END IF;

  SELECT ec.id, ec.wage, ec.working_schedule
    INTO v_contract_id, v_wage, v_working_schedule
  FROM public.employee_contracts ec
  WHERE ec.employee_id = p_employee_id
    AND ec.status = 'running'
    AND ec.start_date <= v_today
    AND (ec.end_date IS NULL OR ec.end_date >= v_today)
  ORDER BY ec.start_date DESC
  LIMIT 1;

  v_has_contract := v_contract_id IS NOT NULL;
  v_has_schedule := v_working_schedule IS NOT NULL;

  IF v_has_contract THEN
    SELECT COALESCE(v_wage, 0) +
           COALESCE((
             SELECT SUM(ccc.amount)
               FROM public.contract_compensation_components ccc
              WHERE ccc.contract_id = v_contract_id
           ), 0)
      INTO v_salary;
    v_has_salary := v_salary > 0;
  END IF;

  SELECT (e.bank_account_number IS NOT NULL AND e.bank_account_number <> '')
      OR (e.bank_name IS NOT NULL AND e.bank_name <> '')
    INTO v_has_bank
  FROM public.employees e WHERE e.id = p_employee_id;

  SELECT COALESCE(array_agg(DISTINCT pref.requirement_key), ARRAY[]::text[])
    INTO v_required
  FROM public.pack_required_employee_fields(v_business_id, 'payroll') pref
  WHERE pref.scope = 'statutory_identifier'
    AND pref.is_required = true
    AND pref.blocks_payroll = true;

  SELECT COALESCE(array_agg(DISTINCT esi.identifier_type), ARRAY[]::text[])
    INTO v_present
  FROM public.employee_statutory_identifiers esi
  WHERE esi.employee_id = p_employee_id
    AND esi.is_active = true
    AND COALESCE(esi.identifier_value, '') <> '';

  SELECT COALESCE(array_agg(k), ARRAY[]::text[]) INTO v_missing
  FROM unnest(v_required) AS k
  WHERE k <> ALL(v_present);

  IF NOT v_has_contract THEN v_blockers := v_blockers || 'Active contract missing'; END IF;
  IF v_has_contract AND NOT v_has_salary THEN v_blockers := v_blockers || 'Salary not set on contract'; END IF;
  IF v_has_contract AND NOT v_has_schedule THEN v_blockers := v_blockers || 'Working schedule missing'; END IF;
  IF COALESCE(array_length(v_missing, 1), 0) > 0 THEN
    v_blockers := v_blockers || ('Missing statutory identifier(s): ' || array_to_string(v_missing, ', '));
  END IF;

  RETURN QUERY SELECT
    p_employee_id,
    v_has_contract, v_has_salary, v_has_schedule, v_has_bank,
    v_required, v_present, v_missing,
    (v_has_contract AND v_has_salary AND v_has_schedule
     AND COALESCE(array_length(v_missing,1),0) = 0),
    v_blockers;
END $function$;
