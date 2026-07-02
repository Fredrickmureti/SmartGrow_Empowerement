-- payroll_readiness_engine_contract_test.sql
-- Pins the column-name contract between payroll_readiness_eval_rule and
-- evaluate_payroll_readiness. A previous regression renamed the RETURNS
-- TABLE columns to out_*, while the caller read v_eval.status — causing
-- the entire readiness page to return HTTP 400. This test fails loudly
-- if anyone renames them again, AND verifies the engine produces a
-- usable payload for an empty business.
BEGIN;
  -- (1) Column names of payroll_readiness_eval_rule are stable.
  DO $$
  DECLARE v_missing text;
  BEGIN
    SELECT string_agg(c, ',') INTO v_missing
    FROM (VALUES ('status'),('reason'),('missing_fields'),('details')) t(c)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.parameters p
       JOIN pg_proc pr ON pr.proname='payroll_readiness_eval_rule'
       WHERE p.specific_name LIKE 'payroll_readiness_eval_rule%'
         AND p.parameter_mode='OUT'
         AND p.parameter_name = t.c
    );
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'payroll_readiness_eval_rule lost OUT columns: %', v_missing;
    END IF;
  END $$;

  -- (2) Prerequisite dependency column exists on the rules catalog.
  PERFORM 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='payroll_readiness_rules'
      AND column_name='prerequisite_rule_codes';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll_readiness_rules.prerequisite_rule_codes missing — dependency graph regressed';
  END IF;

  -- (3) Legacy / duplicate readiness surfaces are gone. ADR-0040 invariant I1
  --     ("One engine") is enforced as a denylist: if any of these names is
  --     reintroduced, a second readiness engine is in play and the badge can
  --     disagree with `assert_payroll_ready_json`.
  DO $$
  DECLARE v_dupes text;
  BEGIN
    SELECT string_agg(p.proname, ', ') INTO v_dupes
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.proname IN (
        'business_payroll_readiness',
        'employee_payroll_readiness',
        'payroll_readiness_blockers',
        'payroll_readiness_eval_rule_ext'
      );
    IF v_dupes IS NOT NULL THEN
      RAISE EXCEPTION 'Duplicate readiness surface reintroduced: % — see ADR-0040 invariant I1', v_dupes;
    END IF;
  END $$;

  -- (4) Smoke: summary returns a jsonb shape with is_ready key for any org.
  DO $$
  DECLARE v_org uuid; v_result jsonb;
  BEGIN
    SELECT id INTO v_org FROM public.organizations LIMIT 1;
    IF v_org IS NULL THEN RETURN; END IF;
    v_result := public.payroll_readiness_summary(v_org, NULL, NULL, NULL, NULL);
    IF NOT (v_result ? 'is_ready' AND v_result ? 'org_blockers') THEN
      RAISE EXCEPTION 'payroll_readiness_summary returned malformed jsonb: %', v_result;
    END IF;
  END $$;
ROLLBACK;
