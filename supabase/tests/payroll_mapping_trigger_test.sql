-- =====================================================================
-- pgTAP — Wave-3 default_account_settings payroll role trigger.
--
-- Exercises `_payroll_assert_mapping_role` via real INSERT/UPDATE on
-- `default_account_settings` to prove the BEFORE trigger fires for every
-- writer (including raw PostgREST upserts that bypass
-- payroll_apply_proposed_mappings).
--
-- Run with:
--   supabase test db --linked --file payroll_mapping_trigger_test.sql
-- =====================================================================
BEGIN;
SELECT plan(6);

DO $$
DECLARE
  v_org_id     uuid;
  v_biz_id     uuid;
  v_salary_acc uuid;  -- 6xxx expense
  v_cogs_acc   uuid;  -- 5xxx COGS expense
  v_liab_acc   uuid;  -- 2xxx liability
BEGIN
  SELECT id INTO v_org_id FROM public.organizations LIMIT 1;
  SELECT id INTO v_biz_id FROM public.businesses WHERE organization_id = v_org_id LIMIT 1;

  IF v_org_id IS NULL OR v_biz_id IS NULL THEN
    RAISE NOTICE 'Skipping: no org/business in this env';
    RETURN;
  END IF;

  -- Salary expense candidate: account_type=expense, code in 6xxx, not COGS, not header
  SELECT a.id INTO v_salary_acc
  FROM public.accounts a
  WHERE a.organization_id = v_org_id
    AND a.account_type::text = 'expense'
    AND COALESCE(a.is_header, false) = false
    AND NOT public._payroll_is_cogs_account(a.id)
    AND a.code ~ '^6'
  ORDER BY a.code
  LIMIT 1;

  -- COGS candidate: an expense account flagged as cost-of-sales
  SELECT a.id INTO v_cogs_acc
  FROM public.accounts a
  WHERE a.organization_id = v_org_id
    AND a.account_type::text = 'expense'
    AND COALESCE(a.is_header, false) = false
    AND public._payroll_is_cogs_account(a.id)
  ORDER BY a.code
  LIMIT 1;

  -- Statutory liability candidate
  SELECT a.id INTO v_liab_acc
  FROM public.accounts a
  WHERE a.organization_id = v_org_id
    AND a.account_type::text = 'liability'
    AND COALESCE(a.is_header, false) = false
  ORDER BY a.code
  LIMIT 1;

  IF v_salary_acc IS NULL OR v_cogs_acc IS NULL OR v_liab_acc IS NULL THEN
    RAISE NOTICE 'Skipping: missing seed accounts (salary=% cogs=% liab=%)',
      v_salary_acc, v_cogs_acc, v_liab_acc;
    RETURN;
  END IF;

  PERFORM set_config('tap.org_id', v_org_id::text, true);
  PERFORM set_config('tap.biz_id', v_biz_id::text, true);
  PERFORM set_config('tap.salary_acc', v_salary_acc::text, true);
  PERFORM set_config('tap.cogs_acc',   v_cogs_acc::text, true);
  PERFORM set_config('tap.liab_acc',   v_liab_acc::text, true);
END $$;

-- Clean any prior test rows so reruns are deterministic.
DELETE FROM public.default_account_settings
WHERE setting_key IN (
  '__tap_payroll_salary_expense',
  '__tap_payroll_paye_payable',
  '__tap_payroll_employer_nssf_expense',
  '__tap_unrelated_key'
);

-- ---------------------------------------------------------------------
-- 1. Valid: salary_expense → 6xxx expense account.
--    NOTE: the trigger only fires for the canonical payroll keys
--    ('salary_expense', '%_payable', '%_employer_expense'). We use the
--    real keys with a sentinel suffix that still matches the patterns.
-- ---------------------------------------------------------------------
SELECT lives_ok($$
  INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id)
  VALUES (
    current_setting('tap.org_id')::uuid,
    current_setting('tap.biz_id')::uuid,
    'salary_expense',
    current_setting('tap.salary_acc')::uuid
  )
  ON CONFLICT (organization_id, business_id, setting_key)
  DO UPDATE SET account_id = EXCLUDED.account_id;
$$, 'salary_expense → 6xxx expense account is accepted');

-- ---------------------------------------------------------------------
-- 2. Invalid: salary_expense → 5xxx COGS account must raise.
-- ---------------------------------------------------------------------
SELECT throws_like($$
  INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id)
  VALUES (
    current_setting('tap.org_id')::uuid,
    current_setting('tap.biz_id')::uuid,
    'salary_expense',
    current_setting('tap.cogs_acc')::uuid
  )
  ON CONFLICT (organization_id, business_id, setting_key)
  DO UPDATE SET account_id = EXCLUDED.account_id;
$$,
  '%payroll_mapping_role_violation%Cost of%',
  'salary_expense → COGS account is rejected');

-- ---------------------------------------------------------------------
-- 3. Invalid: *_payable → expense-class account must raise.
-- ---------------------------------------------------------------------
SELECT throws_like($$
  INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id)
  VALUES (
    current_setting('tap.org_id')::uuid,
    current_setting('tap.biz_id')::uuid,
    'paye_payable',
    current_setting('tap.salary_acc')::uuid
  )
  ON CONFLICT (organization_id, business_id, setting_key)
  DO UPDATE SET account_id = EXCLUDED.account_id;
$$,
  '%payroll_mapping_role_violation%liability%',
  'paye_payable → expense account is rejected');

-- ---------------------------------------------------------------------
-- 4. Invalid: *_employer_expense → COGS account must raise.
-- ---------------------------------------------------------------------
SELECT throws_like($$
  INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id)
  VALUES (
    current_setting('tap.org_id')::uuid,
    current_setting('tap.biz_id')::uuid,
    'employer_nssf_expense',
    current_setting('tap.cogs_acc')::uuid
  )
  ON CONFLICT (organization_id, business_id, setting_key)
  DO UPDATE SET account_id = EXCLUDED.account_id;
$$,
  '%payroll_mapping_role_violation%Cost of%',
  'employer_*_expense → COGS account is rejected');

-- ---------------------------------------------------------------------
-- 5. UPDATE path: flipping a valid salary_expense mapping to a COGS
--    account must raise and leave the row unchanged.
-- ---------------------------------------------------------------------
SELECT throws_like($$
  UPDATE public.default_account_settings
     SET account_id = current_setting('tap.cogs_acc')::uuid
   WHERE organization_id = current_setting('tap.org_id')::uuid
     AND business_id     = current_setting('tap.biz_id')::uuid
     AND setting_key     = 'salary_expense';
$$,
  '%payroll_mapping_role_violation%',
  'UPDATE salary_expense → COGS is rejected');

SELECT is(
  (SELECT account_id FROM public.default_account_settings
    WHERE organization_id = current_setting('tap.org_id')::uuid
      AND business_id     = current_setting('tap.biz_id')::uuid
      AND setting_key     = 'salary_expense'),
  current_setting('tap.salary_acc')::uuid,
  'salary_expense row still points at the original 6xxx account after rejected UPDATE'
);

-- Cleanup
DELETE FROM public.default_account_settings
WHERE setting_key IN ('salary_expense', 'paye_payable', 'employer_nssf_expense')
  AND organization_id = current_setting('tap.org_id')::uuid
  AND business_id     = current_setting('tap.biz_id')::uuid;

SELECT * FROM finish();
ROLLBACK;
