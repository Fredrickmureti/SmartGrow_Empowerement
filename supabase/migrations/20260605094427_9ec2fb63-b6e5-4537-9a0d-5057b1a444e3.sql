-- =====================================================================
-- Wave 1A: Payroll Readiness foundation
-- =====================================================================
-- Greenfield, declarative readiness layer. Replaces the ad-hoc "missing"
-- text array inside assert_payroll_ready with a queryable findings table
-- that the UI and the engine both consume. Designed so that adding a new
-- check for a new country requires inserting a rule row, not editing code.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. RULES CATALOG
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payroll_readiness_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL organization_id = global core rule (applies to every org)
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Optional pack lineage for pack-sourced rules (Wave 3)
  pack_id         uuid REFERENCES public.localization_packs(id) ON DELETE SET NULL,
  code            text NOT NULL,
  name            text NOT NULL,
  description     text,
  -- org | employee | run
  scope           text NOT NULL CHECK (scope IN ('org','employee','run')),
  -- block | warn | info
  severity        text NOT NULL DEFAULT 'block' CHECK (severity IN ('block','warn','info')),
  -- core | pack | custom
  source          text NOT NULL DEFAULT 'core' CHECK (source IN ('core','pack','custom')),
  -- Typed reason_code consumed by the UI for deep-link routing (replaces
  -- the regex-on-English-strings approach in PayrollSetupGate).
  reason_code     text NOT NULL,
  -- For built-in evaluator dispatch (core rules). Pack/custom rules can
  -- supply predicate_sql instead (Wave 3 extension point).
  check_kind      text,
  predicate_sql   text,
  remediation_label text,
  remediation_link  text,
  is_active       boolean NOT NULL DEFAULT true,
  sort_order      int NOT NULL DEFAULT 100,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_readiness_rules_code_scope_uq
    UNIQUE (organization_id, code)
);

CREATE INDEX IF NOT EXISTS idx_prr_active_scope
  ON public.payroll_readiness_rules (is_active, scope) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_prr_pack ON public.payroll_readiness_rules (pack_id);

GRANT SELECT ON public.payroll_readiness_rules TO authenticated;
GRANT ALL    ON public.payroll_readiness_rules TO service_role;

ALTER TABLE public.payroll_readiness_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read readiness rules"
  ON public.payroll_readiness_rules FOR SELECT TO authenticated
  USING (
    organization_id IS NULL
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = payroll_readiness_rules.organization_id
        AND ur.is_active = true
    )
  );

CREATE POLICY "Service role writes readiness rules"
  ON public.payroll_readiness_rules FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------
-- 2. FINDINGS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payroll_readiness_findings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id     uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  rule_id         uuid NOT NULL REFERENCES public.payroll_readiness_rules(id) ON DELETE CASCADE,
  -- org | employee | run
  subject_type    text NOT NULL CHECK (subject_type IN ('org','employee','run')),
  -- NULL when subject_type='org'
  subject_id      uuid,
  -- pass | fail | warn | skip
  status          text NOT NULL CHECK (status IN ('pass','fail','warn','skip')),
  reason          text,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing_fields  text[] NOT NULL DEFAULT ARRAY[]::text[],
  evaluated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prf_uq UNIQUE (organization_id, business_id, subject_type, subject_id, rule_id)
);

CREATE INDEX IF NOT EXISTS idx_prf_org_status
  ON public.payroll_readiness_findings (organization_id, business_id, status);
CREATE INDEX IF NOT EXISTS idx_prf_subject
  ON public.payroll_readiness_findings (subject_type, subject_id);

GRANT SELECT ON public.payroll_readiness_findings TO authenticated;
GRANT ALL    ON public.payroll_readiness_findings TO service_role;

ALTER TABLE public.payroll_readiness_findings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read readiness findings"
  ON public.payroll_readiness_findings FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = payroll_readiness_findings.organization_id
        AND ur.is_active = true
    )
  );

CREATE POLICY "Service role writes readiness findings"
  ON public.payroll_readiness_findings FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------
-- 3. RUNS (audit trail)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payroll_readiness_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id     uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  scope           text NOT NULL CHECK (scope IN ('org','employee','run','all')),
  subject_id      uuid,
  triggered_by    uuid,
  triggered_reason text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  pass_count      int NOT NULL DEFAULT 0,
  fail_count      int NOT NULL DEFAULT 0,
  warn_count      int NOT NULL DEFAULT 0,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_prruns_org_started
  ON public.payroll_readiness_runs (organization_id, started_at DESC);

GRANT SELECT ON public.payroll_readiness_runs TO authenticated;
GRANT ALL    ON public.payroll_readiness_runs TO service_role;

ALTER TABLE public.payroll_readiness_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read readiness runs"
  ON public.payroll_readiness_runs FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = payroll_readiness_runs.organization_id
        AND ur.is_active = true
    )
  );

CREATE POLICY "Service role writes readiness runs"
  ON public.payroll_readiness_runs FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------
-- 4. updated_at trigger for rules
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_payroll_readiness_rules()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prr_touch ON public.payroll_readiness_rules;
CREATE TRIGGER trg_prr_touch
  BEFORE UPDATE ON public.payroll_readiness_rules
  FOR EACH ROW EXECUTE FUNCTION public.touch_payroll_readiness_rules();

-- ---------------------------------------------------------------------
-- 5. CORE RULE EVALUATORS — built-in dispatch by check_kind.
--    Each evaluator returns (status, reason, missing_fields, details).
--    Adding a new check_kind requires editing this dispatch; pack rules
--    use predicate_sql instead and can be added without code changes.
-- ---------------------------------------------------------------------
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
  v_status text := 'pass';
  v_reason text;
  v_missing text[] := ARRAY[]::text[];
  v_details jsonb := '{}'::jsonb;
  v_invalid text;
  v_count int;
BEGIN
  CASE p_rule.check_kind

  WHEN 'org.localization_pack_installed' THEN
    IF NOT EXISTS (SELECT 1 FROM installed_localization_packs WHERE organization_id = p_org_id) THEN
      v_status := 'fail';
      v_reason := 'No localization pack installed for this organization.';
      v_missing := ARRAY['localization_pack'];
    END IF;

  WHEN 'org.salary_structure_active' THEN
    IF NOT EXISTS (SELECT 1 FROM salary_structures WHERE organization_id = p_org_id AND is_active = true) THEN
      v_status := 'fail';
      v_reason := 'No active salary structure has been defined.';
      v_missing := ARRAY['salary_structure'];
    END IF;

  WHEN 'org.payroll_accounts_mapped' THEN
    IF NOT EXISTS (
      SELECT 1 FROM default_account_settings
      WHERE organization_id = p_org_id
        AND account_id IS NOT NULL
        AND (p_business_id IS NULL OR business_id IS NULL OR business_id = p_business_id)
    ) THEN
      v_status := 'fail';
      v_reason := 'Payroll GL accounts have not been mapped.';
      v_missing := ARRAY['payroll_gl_accounts'];
    END IF;

  WHEN 'org.statutory_rules_active' THEN
    IF NOT EXISTS (
      SELECT 1 FROM payroll_statutory_rules
      WHERE organization_id = p_org_id
        AND is_active = true
        AND (effective_to IS NULL OR effective_to >= COALESCE(p_period_end, CURRENT_DATE))
    ) THEN
      v_status := 'fail';
      v_reason := 'No active statutory rules in effect for the period.';
      v_missing := ARRAY['statutory_rules'];
    END IF;

  WHEN 'org.statutory_rules_valid_method' THEN
    SELECT string_agg(rule_name, ', ' ORDER BY rule_name) INTO v_invalid
    FROM payroll_statutory_rules
    WHERE organization_id = p_org_id
      AND is_active = true
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
      v_status := 'fail';
      v_reason := 'No payroll periods have been generated.';
      v_missing := ARRAY['payroll_periods'];
    END IF;

  -- =============== EMPLOYEE SCOPE ===============
  WHEN 'employee.active_contract' THEN
    IF NOT EXISTS (
      SELECT 1 FROM employee_contracts
      WHERE organization_id = p_org_id
        AND employee_id = p_subject_id
        AND status IN ('running','new','active')
        AND (p_business_id IS NULL OR business_id = p_business_id)
        AND (p_period_end IS NULL OR start_date <= p_period_end)
        AND (p_period_start IS NULL OR end_date IS NULL OR end_date >= p_period_start)
    ) THEN
      v_status := 'fail';
      v_reason := 'Employee has no active contract for the period.';
      v_missing := ARRAY['employee_contract'];
    END IF;

  WHEN 'employee.contract_has_salary' THEN
    IF NOT EXISTS (
      SELECT 1 FROM employee_contracts ec
      WHERE ec.organization_id = p_org_id
        AND ec.employee_id = p_subject_id
        AND ec.status IN ('running','new','active')
        AND COALESCE(ec.wage, 0) > 0
    ) THEN
      v_status := 'fail';
      v_reason := 'Active contract has no wage / salary amount.';
      v_missing := ARRAY['contract_wage'];
    END IF;

  WHEN 'employee.contract_has_schedule' THEN
    IF NOT EXISTS (
      SELECT 1 FROM employee_contracts ec
      WHERE ec.organization_id = p_org_id
        AND ec.employee_id = p_subject_id
        AND ec.status IN ('running','new','active')
        AND ec.working_schedule IS NOT NULL
    ) THEN
      v_status := 'fail';
      v_reason := 'Active contract has no working schedule.';
      v_missing := ARRAY['contract_schedule'];
    END IF;

  WHEN 'employee.has_statutory_identifiers' THEN
    -- Wave 3 will tighten this against the pack's required identifier set.
    IF NOT EXISTS (
      SELECT 1 FROM employee_statutory_identifiers
      WHERE employee_id = p_subject_id
    ) THEN
      v_status := 'warn';
      v_reason := 'Employee has no statutory identifiers recorded.';
      v_missing := ARRAY['statutory_identifiers'];
    END IF;

  WHEN 'employee.has_payment_info' THEN
    IF NOT EXISTS (
      SELECT 1 FROM employees
      WHERE id = p_subject_id
        AND (bank_account_number IS NOT NULL OR bank_name IS NOT NULL)
    ) THEN
      v_status := 'warn';
      v_reason := 'Employee has no bank / payment information.';
      v_missing := ARRAY['payment_info'];
    END IF;

  -- =============== RUN SCOPE ===============
  WHEN 'run.period_not_closed' THEN
    IF EXISTS (
      SELECT 1 FROM payroll_runs pr
      JOIN fiscal_periods fp ON fp.organization_id = pr.organization_id
        AND fp.status = 'closed'
        AND pr.period_start BETWEEN fp.start_date AND fp.end_date
      WHERE pr.id = p_subject_id
    ) THEN
      v_status := 'fail';
      v_reason := 'Payroll period falls inside a closed fiscal period.';
      v_missing := ARRAY['fiscal_period_open'];
    END IF;

  WHEN 'run.no_duplicate_regular' THEN
    SELECT count(*) INTO v_count
    FROM payroll_runs pr
    WHERE pr.id <> p_subject_id
      AND pr.organization_id = p_org_id
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

  ELSE
    -- Unknown check_kind. For pack/custom rules, fall back to predicate_sql.
    IF p_rule.predicate_sql IS NOT NULL AND length(trim(p_rule.predicate_sql)) > 0 THEN
      -- predicate_sql must SELECT a single boolean column; true = pass.
      DECLARE v_ok boolean;
      BEGIN
        EXECUTE p_rule.predicate_sql
          INTO v_ok
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

  -- Coerce severity-aware status: a 'warn' severity rule that fails becomes 'warn'
  IF v_status = 'fail' AND p_rule.severity = 'warn' THEN
    v_status := 'warn';
  END IF;

  RETURN QUERY SELECT v_status, v_reason, v_missing, v_details;
END;
$$;

-- ---------------------------------------------------------------------
-- 6. EVALUATOR ENTRY POINT
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.evaluate_payroll_readiness(
  p_org_id        uuid,
  p_business_id   uuid DEFAULT NULL,
  p_scope         text DEFAULT 'org',
  p_subject_ids   uuid[] DEFAULT NULL,
  p_period_start  date  DEFAULT NULL,
  p_period_end    date  DEFAULT NULL
) RETURNS public.payroll_readiness_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
        ON CONFLICT (organization_id, business_id, subject_type, subject_id, rule_id)
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

  UPDATE payroll_readiness_runs
     SET finished_at = now(), pass_count = v_pass, fail_count = v_fail, warn_count = v_warn
   WHERE id = v_run.id
   RETURNING * INTO v_run;

  RETURN v_run;
END;
$$;

GRANT EXECUTE ON FUNCTION public.evaluate_payroll_readiness(uuid, uuid, text, uuid[], date, date) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7. CONVENIENCE HELPERS
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_readiness_blockers(
  p_org_id      uuid,
  p_business_id uuid DEFAULT NULL,
  p_scope       text DEFAULT 'org',
  p_subject_id  uuid DEFAULT NULL
) RETURNS TABLE (
  rule_code text, rule_name text, reason text, reason_code text,
  remediation_label text, remediation_link text, missing_fields text[]
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.code, r.name, f.reason, r.reason_code,
         r.remediation_label, r.remediation_link, f.missing_fields
  FROM payroll_readiness_findings f
  JOIN payroll_readiness_rules r ON r.id = f.rule_id
  WHERE f.organization_id = p_org_id
    AND (p_business_id IS NULL OR f.business_id = p_business_id OR f.business_id IS NULL)
    AND f.subject_type = p_scope
    AND (p_subject_id IS NULL OR f.subject_id = p_subject_id)
    AND f.status = 'fail'
    AND r.severity = 'block'
  ORDER BY r.sort_order, r.code;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_readiness_blockers(uuid, uuid, text, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 8. SEED CORE RULES (global, organization_id = NULL)
-- ---------------------------------------------------------------------
INSERT INTO public.payroll_readiness_rules
  (organization_id, code, name, description, scope, severity, source, reason_code, check_kind, remediation_label, remediation_link, sort_order)
VALUES
  -- ORG
  (NULL, 'org.localization_pack_installed',  'Localization pack installed',     'A country pack must be installed before payroll can run.', 'org', 'block', 'core', 'LOCALIZATION_MISSING',  'org.localization_pack_installed', 'Install localization pack', '/hr/payroll/setup', 10),
  (NULL, 'org.payroll_accounts_mapped',      'Payroll GL accounts mapped',      'Default payroll account mappings are required for GL posting.', 'org', 'block', 'core', 'GL_ACCOUNTS_MISSING',   'org.payroll_accounts_mapped',     'Map payroll GL accounts',   '/hr/payroll/account-mapping', 20),
  (NULL, 'org.statutory_rules_active',       'Statutory rules in effect',       'At least one active statutory rule is required for the period.', 'org', 'block', 'core', 'STATUTORY_MISSING',     'org.statutory_rules_active',      'Configure statutory rules', '/hr/payroll/statutory-rules', 30),
  (NULL, 'org.statutory_rules_valid_method', 'Statutory rules have valid method','Every active statutory rule needs a known computation_method.', 'org', 'block', 'core', 'STATUTORY_METHOD',      'org.statutory_rules_valid_method','Fix statutory rule methods','/hr/payroll/statutory-rules', 31),
  (NULL, 'org.salary_structure_active',      'Salary structure defined',        'At least one active salary structure is required.', 'org', 'block', 'core', 'SALARY_STRUCTURE',      'org.salary_structure_active',     'Define salary structure',   '/hr/payroll/configuration/structures', 40),
  (NULL, 'org.payroll_period_exists',        'Payroll periods generated',       'Payroll periods must be generated before runs can be created.', 'org', 'block', 'core', 'PERIODS_MISSING',       'org.payroll_period_exists',       'Generate payroll periods',  '/hr/payroll/setup', 50),

  -- EMPLOYEE
  (NULL, 'employee.active_contract',         'Active contract for the period',  'Each employee on the run must have an active contract.', 'employee', 'block', 'core', 'EMP_NO_CONTRACT',  'employee.active_contract',         'Create contract',  '/hr/employees', 110),
  (NULL, 'employee.contract_has_salary',     'Contract wage > 0',               'Active contract must specify a wage amount.', 'employee', 'block', 'core', 'EMP_NO_WAGE',      'employee.contract_has_salary',     'Set contract wage','/hr/employees', 120),
  (NULL, 'employee.contract_has_schedule',   'Contract has working schedule',   'Active contract must reference a working schedule.', 'employee', 'block', 'core', 'EMP_NO_SCHEDULE',  'employee.contract_has_schedule',   'Set schedule',     '/hr/employees', 130),
  (NULL, 'employee.has_statutory_identifiers','Statutory identifiers recorded', 'Employee should have the statutory identifiers required by the active pack.', 'employee', 'warn', 'core', 'EMP_NO_STAT_IDS',  'employee.has_statutory_identifiers','Add identifiers', '/hr/employees', 140),
  (NULL, 'employee.has_payment_info',        'Payment information recorded',    'Employee should have bank / payment information for payouts.', 'employee', 'warn', 'core', 'EMP_NO_PAYMENT',   'employee.has_payment_info',        'Add bank details','/hr/employees', 150),

  -- RUN
  (NULL, 'run.period_not_closed',            'Period not in a closed fiscal period', 'Cannot run payroll inside a closed fiscal period.', 'run', 'block', 'core', 'RUN_PERIOD_CLOSED', 'run.period_not_closed',            'Reopen period',    '/finance/fiscal-periods', 210),
  (NULL, 'run.no_duplicate_regular',         'No duplicate regular run for period',  'Only one regular run is allowed per payroll period.','run', 'block', 'core', 'RUN_DUPLICATE',     'run.no_duplicate_regular',         'Review existing runs','/hr/payroll/runs', 220)
ON CONFLICT (organization_id, code) DO NOTHING;

-- ---------------------------------------------------------------------
-- 9. REWRITE assert_payroll_ready TO DELEGATE TO THE NEW LAYER
--    Keeps the same signature and exception shape so existing callers
--    (compute-payroll, post-payroll-gl) work unchanged.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_payroll_ready(
  p_org_id       uuid,
  p_business_id  uuid DEFAULT NULL,
  p_employee_ids uuid[] DEFAULT NULL,
  p_period_start date DEFAULT NULL,
  p_period_end   date DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_blocker record;
BEGIN
  -- Evaluate ORG scope synchronously so the assertion always reflects
  -- current state (no reliance on cached app_setup_status).
  PERFORM evaluate_payroll_readiness(p_org_id, p_business_id, 'org', NULL, p_period_start, p_period_end);
  FOR v_blocker IN
    SELECT reason, reason_code FROM payroll_readiness_blockers(p_org_id, p_business_id, 'org', NULL)
  LOOP
    v_missing := array_append(v_missing, COALESCE(v_blocker.reason, v_blocker.reason_code));
  END LOOP;

  -- Evaluate EMPLOYEE scope for the selected employees (if any).
  IF p_employee_ids IS NOT NULL AND array_length(p_employee_ids, 1) IS NOT NULL THEN
    PERFORM evaluate_payroll_readiness(p_org_id, p_business_id, 'employee', p_employee_ids, p_period_start, p_period_end);
    -- Count of distinct employees with at least one block-severity failure.
    DECLARE v_bad int;
    BEGIN
      SELECT count(DISTINCT f.subject_id) INTO v_bad
      FROM payroll_readiness_findings f
      JOIN payroll_readiness_rules r ON r.id = f.rule_id
      WHERE f.organization_id = p_org_id
        AND f.subject_type = 'employee'
        AND f.subject_id = ANY (p_employee_ids)
        AND f.status = 'fail'
        AND r.severity = 'block';
      IF v_bad > 0 THEN
        v_missing := array_append(v_missing, v_bad || ' selected employee(s) failing readiness checks');
      END IF;
    END;
  ELSE
    -- No explicit selection: at least one employee must have a valid contract.
    IF NOT EXISTS (
      SELECT 1 FROM employee_contracts
      WHERE organization_id = p_org_id
        AND status IN ('running','new','active')
        AND (p_business_id IS NULL OR business_id = p_business_id)
    ) THEN
      v_missing := array_append(v_missing, 'active employee contract');
    END IF;
  END IF;

  IF array_length(v_missing, 1) IS NULL THEN
    RETURN true;
  END IF;

  RAISE EXCEPTION 'SETUP_REQUIRED: Payroll cannot run yet. Missing: %.', array_to_string(v_missing, ', ')
    USING ERRCODE = 'P0001', HINT = 'payroll_setup_incomplete';
END;
$$;
