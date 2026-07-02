
-- =====================================================================
-- Wave 1C — Close the payroll readiness layer
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Uniqueness: NULL business_id / subject_id must not duplicate
-- ---------------------------------------------------------------------
-- Postgres treats NULLs as distinct in UNIQUE constraints, so the
-- existing (organization_id, business_id, subject_type, subject_id, rule_id)
-- constraint allows duplicate org-scope findings. Replace with an
-- expression-based unique index that coerces NULLs to a sentinel.

ALTER TABLE public.payroll_readiness_findings DROP CONSTRAINT IF EXISTS prf_uq;

CREATE UNIQUE INDEX IF NOT EXISTS prf_uq_expr
  ON public.payroll_readiness_findings (
    organization_id,
    COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid),
    subject_type,
    COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'::uuid),
    rule_id
  );

-- ---------------------------------------------------------------------
-- 2. Quiet evaluator used by triggers (no payroll_readiness_runs row)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.evaluate_payroll_readiness_quiet(
  p_org_id        uuid,
  p_business_id   uuid DEFAULT NULL,
  p_scope         text DEFAULT 'org',
  p_subject_ids   uuid[] DEFAULT NULL,
  p_period_start  date  DEFAULT NULL,
  p_period_end    date  DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rule public.payroll_readiness_rules;
  v_subject uuid;
  v_subjects uuid[];
  v_eval record;
BEGIN
  IF p_org_id IS NULL THEN RETURN; END IF;

  IF p_scope IN ('employee','run') THEN
    v_subjects := COALESCE(p_subject_ids, ARRAY[]::uuid[]);
    IF array_length(v_subjects, 1) IS NULL THEN RETURN; END IF;
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
      END LOOP;
    END LOOP;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.evaluate_payroll_readiness_quiet(uuid, uuid, text, uuid[], date, date)
  TO authenticated, service_role;

-- Rewrite the public evaluator to use the same ON CONFLICT expression
-- so behaviour matches the new uniqueness shape.
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

  -- Garbage collect findings whose rule is no longer active or whose
  -- subject no longer exists.
  PERFORM public.gc_payroll_readiness_findings(p_org_id);

  UPDATE payroll_readiness_runs
     SET finished_at = now(), pass_count = v_pass, fail_count = v_fail, warn_count = v_warn
   WHERE id = v_run.id
   RETURNING * INTO v_run;

  RETURN v_run;
END;
$$;

-- ---------------------------------------------------------------------
-- 3. Garbage collection
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gc_payroll_readiness_findings(p_org_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_deleted int := 0;
  v_n int;
BEGIN
  IF p_org_id IS NULL THEN RETURN 0; END IF;

  -- Inactive rules
  DELETE FROM payroll_readiness_findings f
  USING payroll_readiness_rules r
  WHERE f.rule_id = r.id
    AND f.organization_id = p_org_id
    AND r.is_active = false;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted + v_n;

  -- Employee subjects that no longer exist (or are no longer in this org)
  DELETE FROM payroll_readiness_findings f
  WHERE f.organization_id = p_org_id
    AND f.subject_type = 'employee'
    AND f.subject_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM employees e
      WHERE e.id = f.subject_id
        AND e.organization_id = p_org_id
    );
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted + v_n;

  -- Run subjects that no longer exist
  DELETE FROM payroll_readiness_findings f
  WHERE f.organization_id = p_org_id
    AND f.subject_type = 'run'
    AND f.subject_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM payroll_runs pr
      WHERE pr.id = f.subject_id
        AND pr.organization_id = p_org_id
    );
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted + v_n;

  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.gc_payroll_readiness_findings(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Trigger helpers — keep findings fresh when source data changes
-- ---------------------------------------------------------------------

-- ORG-scope: install/uninstall pack, default account mapping, statutory rules
CREATE OR REPLACE FUNCTION public.trg_reeval_org_readiness()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid;
  v_biz uuid;
BEGIN
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  BEGIN
    v_biz := COALESCE(NEW.business_id, OLD.business_id);
  EXCEPTION WHEN undefined_column THEN
    v_biz := NULL;
  END;
  IF v_org IS NOT NULL THEN
    PERFORM public.evaluate_payroll_readiness_quiet(v_org, NULL, 'org', NULL, NULL, NULL);
    -- Also re-eval business scope if applicable
    IF v_biz IS NOT NULL THEN
      PERFORM public.evaluate_payroll_readiness_quiet(v_org, v_biz, 'org', NULL, NULL, NULL);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- Variant that doesn't try to read business_id (for tables without it)
CREATE OR REPLACE FUNCTION public.trg_reeval_org_readiness_nobusiness()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid;
BEGIN
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  IF v_org IS NOT NULL THEN
    PERFORM public.evaluate_payroll_readiness_quiet(v_org, NULL, 'org', NULL, NULL, NULL);
  END IF;
  RETURN NULL;
END;
$$;

-- EMPLOYEE scope: contract change, statutory identifier change, employee row change
CREATE OR REPLACE FUNCTION public.trg_reeval_employee_readiness()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_emp uuid;
  v_org uuid;
  v_biz uuid;
BEGIN
  v_emp := COALESCE(NEW.employee_id, OLD.employee_id);
  IF v_emp IS NULL THEN RETURN NULL; END IF;
  SELECT organization_id, business_id INTO v_org, v_biz
  FROM employees WHERE id = v_emp;
  IF v_org IS NULL THEN RETURN NULL; END IF;
  PERFORM public.evaluate_payroll_readiness_quiet(v_org, v_biz, 'employee', ARRAY[v_emp], NULL, NULL);
  RETURN NULL;
END;
$$;

-- EMPLOYEE scope when the trigger fires on the employees table itself
CREATE OR REPLACE FUNCTION public.trg_reeval_employee_self_readiness()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_emp uuid;
  v_org uuid;
  v_biz uuid;
BEGIN
  v_emp := COALESCE(NEW.id, OLD.id);
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  v_biz := COALESCE(NEW.business_id, OLD.business_id);
  IF v_org IS NULL OR v_emp IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN
    -- finding cleanup handled by gc; just trigger a quiet org-level refresh
    PERFORM public.evaluate_payroll_readiness_quiet(v_org, v_biz, 'org', NULL, NULL, NULL);
  ELSE
    PERFORM public.evaluate_payroll_readiness_quiet(v_org, v_biz, 'employee', ARRAY[v_emp], NULL, NULL);
  END IF;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------
-- 5. Attach triggers
-- ---------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_reeval_readiness_on_installed_packs ON public.installed_localization_packs;
CREATE TRIGGER trg_reeval_readiness_on_installed_packs
  AFTER INSERT OR UPDATE OR DELETE ON public.installed_localization_packs
  FOR EACH ROW EXECUTE FUNCTION public.trg_reeval_org_readiness_nobusiness();

DROP TRIGGER IF EXISTS trg_reeval_readiness_on_default_accounts ON public.default_account_settings;
CREATE TRIGGER trg_reeval_readiness_on_default_accounts
  AFTER INSERT OR UPDATE OR DELETE ON public.default_account_settings
  FOR EACH ROW EXECUTE FUNCTION public.trg_reeval_org_readiness();

DROP TRIGGER IF EXISTS trg_reeval_readiness_on_statutory_rules ON public.payroll_statutory_rules;
CREATE TRIGGER trg_reeval_readiness_on_statutory_rules
  AFTER INSERT OR UPDATE OR DELETE ON public.payroll_statutory_rules
  FOR EACH ROW EXECUTE FUNCTION public.trg_reeval_org_readiness_nobusiness();

DROP TRIGGER IF EXISTS trg_reeval_readiness_on_employee_contracts ON public.employee_contracts;
CREATE TRIGGER trg_reeval_readiness_on_employee_contracts
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_contracts
  FOR EACH ROW EXECUTE FUNCTION public.trg_reeval_employee_readiness();

DROP TRIGGER IF EXISTS trg_reeval_readiness_on_statutory_identifiers ON public.employee_statutory_identifiers;
CREATE TRIGGER trg_reeval_readiness_on_statutory_identifiers
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_statutory_identifiers
  FOR EACH ROW EXECUTE FUNCTION public.trg_reeval_employee_readiness();

DROP TRIGGER IF EXISTS trg_reeval_readiness_on_employees ON public.employees;
CREATE TRIGGER trg_reeval_readiness_on_employees
  AFTER INSERT OR UPDATE OR DELETE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.trg_reeval_employee_self_readiness();

-- ---------------------------------------------------------------------
-- 6. assert_payroll_ready — wire RUN scope rules
--    Backwards compatible: new optional p_run_id at the end.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_payroll_ready(
  p_org_id       uuid,
  p_business_id  uuid DEFAULT NULL,
  p_employee_ids uuid[] DEFAULT NULL,
  p_period_start date DEFAULT NULL,
  p_period_end   date DEFAULT NULL,
  p_run_id       uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_blocker record;
  v_bad int;
BEGIN
  -- ORG scope
  PERFORM evaluate_payroll_readiness(p_org_id, p_business_id, 'org', NULL, p_period_start, p_period_end);
  FOR v_blocker IN
    SELECT reason, reason_code FROM payroll_readiness_blockers(p_org_id, p_business_id, 'org', NULL)
  LOOP
    v_missing := array_append(v_missing, COALESCE(v_blocker.reason, v_blocker.reason_code));
  END LOOP;

  -- EMPLOYEE scope (selected employees)
  IF p_employee_ids IS NOT NULL AND array_length(p_employee_ids, 1) IS NOT NULL THEN
    PERFORM evaluate_payroll_readiness(p_org_id, p_business_id, 'employee', p_employee_ids, p_period_start, p_period_end);
    SELECT count(DISTINCT f.subject_id) INTO v_bad
    FROM payroll_readiness_findings f
    JOIN payroll_readiness_rules r ON r.id = f.rule_id
    WHERE f.organization_id = p_org_id
      AND f.subject_type = 'employee'
      AND f.subject_id = ANY (p_employee_ids)
      AND f.status = 'fail'
      AND r.severity = 'block';
    IF COALESCE(v_bad, 0) > 0 THEN
      v_missing := array_append(v_missing, v_bad || ' selected employee(s) failing readiness checks');
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM employee_contracts
      WHERE organization_id = p_org_id
        AND status IN ('running','new','active')
        AND (p_business_id IS NULL OR business_id = p_business_id)
    ) THEN
      v_missing := array_append(v_missing, 'active employee contract');
    END IF;
  END IF;

  -- RUN scope (only when a run id is supplied)
  IF p_run_id IS NOT NULL THEN
    PERFORM evaluate_payroll_readiness(p_org_id, p_business_id, 'run', ARRAY[p_run_id], p_period_start, p_period_end);
    FOR v_blocker IN
      SELECT reason, reason_code FROM payroll_readiness_blockers(p_org_id, p_business_id, 'run', p_run_id)
    LOOP
      v_missing := array_append(v_missing, COALESCE(v_blocker.reason, v_blocker.reason_code));
    END LOOP;
  END IF;

  IF array_length(v_missing, 1) IS NULL THEN
    RETURN true;
  END IF;

  RAISE EXCEPTION 'SETUP_REQUIRED: Payroll cannot run yet. Missing: %.', array_to_string(v_missing, ', ')
    USING ERRCODE = 'P0001', HINT = 'payroll_setup_incomplete';
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_payroll_ready(uuid, uuid, uuid[], date, date, uuid)
  TO authenticated, service_role;
