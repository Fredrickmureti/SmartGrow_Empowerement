-- Multi-entity guardrail trigger tests.
--
-- Run manually against a non-production database:
--   psql "$DATABASE_URL" -f supabase/tests/multi_entity_triggers_test.sql
--
-- The script wraps every assertion in a SAVEPOINT/ROLLBACK so it can run
-- against an existing dataset without leaving residue. Each assertion
-- raises `notice` on success and `exception` on failure.
--
-- Three triggers are exercised:
--   1. trg_business_currency_lock      — base_currency immutable after first JE
--   2. trg_branch_org_consistency      — branch.organization_id must equal
--                                        its business.organization_id
--   3. trg_je_business_in_org          — JE.business_id must belong to JE.organization_id

BEGIN;

-- Setup: two orgs, one business each, plus a third business owned by org 1.
INSERT INTO organizations (id, name, slug)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'Trigger Test Org 1', 'trig-test-org-1'),
  ('22222222-2222-2222-2222-222222222222', 'Trigger Test Org 2', 'trig-test-org-2');

INSERT INTO businesses (id, organization_id, name, base_currency, is_active)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Biz A', 'USD', true),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'Biz B', 'EUR', true);

-- =========================================================================
-- Test 1: branch with mismatched org must be REJECTED.
-- =========================================================================
DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO branches (organization_id, business_id, name, code)
    VALUES (
      '22222222-2222-2222-2222-222222222222', -- WRONG org
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', -- belongs to org 1
      'Cross-Org Branch',
      'XOB'
    );
  EXCEPTION WHEN OTHERS THEN
    rejected := true;
    RAISE NOTICE 'Test 1 PASSED — branch with mismatched org was rejected: %', SQLERRM;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'Test 1 FAILED — trg_branch_org_consistency did not reject mismatched branch';
  END IF;
END$$;

-- =========================================================================
-- Test 2: journal entry whose business is outside the org must be REJECTED.
-- =========================================================================
DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO journal_entries (
      organization_id, business_id, entry_date, description, status, total_debit, total_credit
    )
    VALUES (
      '11111111-1111-1111-1111-111111111111',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', -- belongs to org 2
      CURRENT_DATE, 'Cross-org JE', 'draft', 0, 0
    );
  EXCEPTION WHEN OTHERS THEN
    rejected := true;
    RAISE NOTICE 'Test 2 PASSED — JE with business outside org was rejected: %', SQLERRM;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'Test 2 FAILED — trg_je_business_in_org did not reject cross-org JE';
  END IF;
END$$;

-- =========================================================================
-- Test 3: base_currency cannot change after the first POSTED JE.
--   We post a tiny JE for biz A, then try to change biz A's currency.
-- =========================================================================
DO $$
DECLARE
  je_id uuid;
  rejected boolean := false;
BEGIN
  -- Insert a posted JE for biz A so the lock activates.
  INSERT INTO journal_entries (
    organization_id, business_id, entry_date, description, status, total_debit, total_credit
  )
  VALUES (
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    CURRENT_DATE, 'Lock-trigger seed', 'posted', 0, 0
  ) RETURNING id INTO je_id;

  BEGIN
    UPDATE businesses
    SET base_currency = 'GBP'
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  EXCEPTION WHEN OTHERS THEN
    rejected := true;
    RAISE NOTICE 'Test 3 PASSED — currency change after JE was rejected: %', SQLERRM;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'Test 3 FAILED — trg_business_currency_lock did not reject post-JE currency change';
  END IF;
END$$;

ROLLBACK;
