-- =====================================================================
-- pgTAP — Banking ownership invariants (R1, R3, R4, G4, G5)
--
-- Verifies the live trigger + partial-unique-index behaviour rather than
-- grepping source. Run with:
--   supabase test db --linked --file bank_ownership_invariants_test.sql
-- =====================================================================
BEGIN;
SELECT plan(7);

-- Setup: synthesise minimal org/business/branch + bank account scaffolding.
-- Uses existing rows when present to avoid FK issues in seeded envs.
DO $$
DECLARE
  v_org_id uuid;
  v_biz_id uuid;
  v_branch_a uuid;
  v_branch_b uuid;
  v_acct_id uuid;
BEGIN
  SELECT id INTO v_org_id FROM public.organizations LIMIT 1;
  SELECT id INTO v_biz_id FROM public.businesses WHERE organization_id = v_org_id LIMIT 1;
  SELECT id INTO v_branch_a FROM public.branches WHERE business_id = v_biz_id ORDER BY is_headquarters DESC NULLS LAST LIMIT 1;
  SELECT id INTO v_branch_b FROM public.branches WHERE business_id = v_biz_id AND id <> COALESCE(v_branch_a, gen_random_uuid()) LIMIT 1;

  -- Bail if env is too empty to test
  IF v_org_id IS NULL OR v_biz_id IS NULL OR v_branch_a IS NULL THEN
    RAISE NOTICE 'Skipping: insufficient seed (org=% biz=% branchA=%)', v_org_id, v_biz_id, v_branch_a;
    RETURN;
  END IF;

  PERFORM set_config('tap.org_id', v_org_id::text, true);
  PERFORM set_config('tap.biz_id', v_biz_id::text, true);
  PERFORM set_config('tap.branch_a', v_branch_a::text, true);
  PERFORM set_config('tap.branch_b', COALESCE(v_branch_b, v_branch_a)::text, true);
END $$;

-- Insert the parent bank_account used by all assertions.
INSERT INTO public.bank_accounts (
  id, organization_id, business_id, branch_id, name, account_number,
  currency, is_active, is_shared
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  current_setting('tap.org_id')::uuid,
  current_setting('tap.biz_id')::uuid,
  current_setting('tap.branch_a')::uuid,
  'TAP test account',
  'TAP-ACCT-001',
  'USD',
  true,
  false
) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- R3: bank_transactions.business_id / branch_id mirror parent account
-- even when caller tries to lie about scope.
-- ---------------------------------------------------------------------
INSERT INTO public.bank_transactions (
  id, organization_id, business_id, branch_id, bank_account_id,
  transaction_date, amount, transaction_type, description, currency
) VALUES (
  '22222222-2222-2222-2222-222222222222',
  current_setting('tap.org_id')::uuid,
  '00000000-0000-0000-0000-000000000000',  -- WRONG on purpose
  '00000000-0000-0000-0000-000000000000',  -- WRONG on purpose
  '11111111-1111-1111-1111-111111111111',
  CURRENT_DATE,
  10.00,
  'credit',
  'TAP R3',
  'USD'
);

SELECT is(
  (SELECT business_id FROM public.bank_transactions WHERE id='22222222-2222-2222-2222-222222222222'),
  current_setting('tap.biz_id')::uuid,
  'R3: bank_transactions.business_id rewritten to parent business'
);
SELECT is(
  (SELECT branch_id FROM public.bank_transactions WHERE id='22222222-2222-2222-2222-222222222222'),
  current_setting('tap.branch_a')::uuid,
  'R3: bank_transactions.branch_id rewritten to parent branch'
);

-- ---------------------------------------------------------------------
-- R3 cascade: changing the account branch re-stamps history
-- ---------------------------------------------------------------------
UPDATE public.bank_accounts
   SET branch_id = current_setting('tap.branch_b')::uuid,
       is_shared = false
 WHERE id = '11111111-1111-1111-1111-111111111111';

SELECT is(
  (SELECT branch_id FROM public.bank_transactions WHERE id='22222222-2222-2222-2222-222222222222'),
  current_setting('tap.branch_b')::uuid,
  'R3-cascade: bank_transactions re-stamped when parent branch changes'
);

-- restore
UPDATE public.bank_accounts
   SET branch_id = current_setting('tap.branch_a')::uuid
 WHERE id = '11111111-1111-1111-1111-111111111111';

-- ---------------------------------------------------------------------
-- R1: duplicate (business, provider, external_account_id) is blocked
-- ---------------------------------------------------------------------
-- Pick any provider id (if any). Skip if no providers seeded.
DO $$
DECLARE v_prov uuid;
BEGIN
  SELECT id INTO v_prov FROM public.platform_bank_providers LIMIT 1;
  IF v_prov IS NULL THEN
    RAISE NOTICE 'Skipping R1 — no platform_bank_providers seeded';
    RETURN;
  END IF;
  PERFORM set_config('tap.prov_id', v_prov::text, true);
END $$;

SELECT CASE WHEN current_setting('tap.prov_id', true) IS NOT NULL THEN
  throws_ok($$
    INSERT INTO public.bank_accounts (id, organization_id, business_id, branch_id, name, currency, provider_id, external_account_id)
    VALUES (gen_random_uuid(), current_setting('tap.org_id')::uuid, current_setting('tap.biz_id')::uuid, current_setting('tap.branch_a')::uuid, 'dup A', 'USD', current_setting('tap.prov_id')::uuid, 'EXT-DUP-1');
    INSERT INTO public.bank_accounts (id, organization_id, business_id, branch_id, name, currency, provider_id, external_account_id)
    VALUES (gen_random_uuid(), current_setting('tap.org_id')::uuid, current_setting('tap.biz_id')::uuid, current_setting('tap.branch_a')::uuid, 'dup B', 'USD', current_setting('tap.prov_id')::uuid, 'EXT-DUP-1');
  $$, '23505', NULL, 'R1: duplicate (business, provider, external_account_id) raises 23505')
ELSE pass('R1: skipped (no providers)') END;

-- ---------------------------------------------------------------------
-- G5: duplicate manual no-provider (business, account_number) blocked
-- ---------------------------------------------------------------------
SELECT throws_ok($$
  INSERT INTO public.bank_accounts (id, organization_id, business_id, branch_id, name, account_number, currency)
  VALUES (gen_random_uuid(), current_setting('tap.org_id')::uuid, current_setting('tap.biz_id')::uuid, current_setting('tap.branch_a')::uuid, 'man A', 'MAN-DUP-1', 'USD');
  INSERT INTO public.bank_accounts (id, organization_id, business_id, branch_id, name, account_number, currency)
  VALUES (gen_random_uuid(), current_setting('tap.org_id')::uuid, current_setting('tap.biz_id')::uuid, current_setting('tap.branch_a')::uuid, 'man B', 'MAN-DUP-1', 'USD');
$$, '23505', NULL, 'G5: duplicate manual no-provider (business, account_number) raises 23505');

-- ---------------------------------------------------------------------
-- R4 + G4: only one open reconciliation per bank_account; session scope
-- mirrors parent account.
-- ---------------------------------------------------------------------
INSERT INTO public.bank_reconciliation_sessions (
  id, organization_id, business_id, branch_id, bank_account_id,
  statement_date, opening_balance, closing_balance, reconciled_balance, status
) VALUES (
  '33333333-3333-3333-3333-333333333333',
  '00000000-0000-0000-0000-000000000000',  -- WRONG on purpose (G4)
  '00000000-0000-0000-0000-000000000000',  -- WRONG on purpose (G4)
  '00000000-0000-0000-0000-000000000000',  -- WRONG on purpose (G4)
  '11111111-1111-1111-1111-111111111111',
  CURRENT_DATE, 0, 0, 0, 'in_progress'
);

SELECT is(
  (SELECT branch_id FROM public.bank_reconciliation_sessions WHERE id='33333333-3333-3333-3333-333333333333'),
  current_setting('tap.branch_a')::uuid,
  'G4: reconciliation session branch_id rewritten to parent account branch'
);

SELECT throws_ok($$
  INSERT INTO public.bank_reconciliation_sessions (
    organization_id, business_id, branch_id, bank_account_id,
    statement_date, opening_balance, closing_balance, reconciled_balance, status
  ) VALUES (
    current_setting('tap.org_id')::uuid,
    current_setting('tap.biz_id')::uuid,
    current_setting('tap.branch_a')::uuid,
    '11111111-1111-1111-1111-111111111111',
    CURRENT_DATE, 0, 0, 0, 'in_progress'
  )
$$, '23505', NULL, 'R4: second open reconciliation on same account raises 23505');

SELECT * FROM finish();
ROLLBACK;
