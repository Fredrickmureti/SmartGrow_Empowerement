-- payroll_role_suggester_test.sql
-- Pins three invariants the previous heuristic suggester violated:
--   (1) salary_expense / net_salary_payable / payroll_clearing ARE registered.
--   (2) payroll_gl_readiness suggests semantically correct accounts (or NULL).
--   (3) the DB rejects a wrong mapping (PAYE Payable as Net Salary Payable).
BEGIN;
  -- (1) Registry contains the three core payroll roles.
  DO $$
  DECLARE missing text;
  BEGIN
    SELECT string_agg(k, ',') INTO missing
    FROM (VALUES ('salary_expense'),('net_salary_payable'),('payroll_clearing')) t(k)
    WHERE NOT EXISTS (SELECT 1 FROM public.system_account_roles s WHERE s.role_key = t.k);
    IF missing IS NOT NULL THEN
      RAISE EXCEPTION 'core payroll roles missing from system_account_roles: %', missing;
    END IF;
  END $$;

  -- (2) Suggester returns the canonical accounts (or NULL — never an unrelated account).
  DO $$
  DECLARE v_org uuid; v_biz uuid; v_label text;
  BEGIN
    SELECT organization_id, id INTO v_org, v_biz FROM public.businesses LIMIT 1;
    IF v_biz IS NULL THEN RAISE NOTICE 'no business; skipping'; RETURN; END IF;

    SELECT suggested_account_label INTO v_label
      FROM public.payroll_gl_readiness(v_org, v_biz)
     WHERE setting_key = 'net_salary_payable';
    IF v_label IS NOT NULL AND v_label NOT LIKE '2170%' THEN
      RAISE EXCEPTION 'net_salary_payable suggested wrong account: %', v_label;
    END IF;

    SELECT suggested_account_label INTO v_label
      FROM public.payroll_gl_readiness(v_org, v_biz)
     WHERE setting_key = 'salary_expense';
    IF v_label IS NOT NULL AND v_label NOT LIKE '6100%' THEN
      RAISE EXCEPTION 'salary_expense suggested wrong account: %', v_label;
    END IF;
  END $$;

  -- (3) DB-level eligibility guard rejects a semantically-wrong mapping.
  DO $$
  DECLARE v_paye uuid;
  BEGIN
    SELECT id INTO v_paye FROM public.accounts WHERE code = '2022' LIMIT 1;
    IF v_paye IS NULL THEN RAISE NOTICE 'no PAYE Payable account; skipping (3)'; RETURN; END IF;
    BEGIN
      PERFORM public._payroll_assert_mapping_role('net_salary_payable', v_paye);
      RAISE EXCEPTION 'expected eligibility guard to reject PAYE Payable as net_salary_payable';
    EXCEPTION WHEN sqlstate '22023' THEN
      -- expected
      NULL;
    END;
  END $$;
ROLLBACK;
