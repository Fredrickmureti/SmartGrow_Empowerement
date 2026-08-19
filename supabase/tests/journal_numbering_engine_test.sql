-- journal_numbering_engine_test.sql
-- Journal numbering is owned by the posting engine, not by its callers.
--
-- Background: `journal_entries.entry_number` is NOT NULL with no default and no
-- trigger. Every caller of `post_journal_entry_atomic` used to have to remember
-- to pre-number its entry; the ones that forgot failed at runtime with
-- `23502 null value in column "entry_number"` (employee loans, stock
-- adjustments, and finally bank opening balances). Numbering now lives inside
-- `post_journal_entry_atomic`, which delegates to the single canonical engine
-- `generate_next_je_number(org, business)`.
--
-- Invariants pinned here:
--   1. `post_journal_entry_atomic` numbers the entry when the caller omits it.
--   2. It refuses to number without a business_id (multi-company isolation).
--   3. `generate_next_je_number` is the ONLY function that derives an entry
--      number; no second numbering engine may reappear.
--   4. `entry_number` still has no column default and no trigger assigning it.

BEGIN;

  --------------------------------------------------------------------------
  -- (1) engine self-numbers when the caller passes NULL
  --------------------------------------------------------------------------
  DO $$
  DECLARE
    v_org uuid; v_biz uuid; v_cash uuid; v_equity uuid;
    v_je uuid; v_no text;
  BEGIN
    SELECT organization_id, id INTO v_org, v_biz
      FROM public.businesses ORDER BY created_at LIMIT 1;
    IF v_biz IS NULL THEN
      RAISE NOTICE 'no business; skipping numbering behaviour test';
      RETURN;
    END IF;

    SELECT id INTO v_cash FROM public.accounts
     WHERE business_id = v_biz AND account_type = 'asset' LIMIT 1;
    v_equity := public.ensure_opening_balance_equity_account(v_org, v_biz);
    IF v_cash IS NULL OR v_equity IS NULL THEN
      RAISE NOTICE 'no usable accounts; skipping numbering behaviour test';
      RETURN;
    END IF;

    v_je := public.post_journal_entry_atomic(
      v_org, v_biz, NULL, CURRENT_DATE,
      'NUMBERING-TEST', 'Engine-assigned numbering', 'numbering_test',
      gen_random_uuid(), NULL, false, false,
      jsonb_build_array(
        jsonb_build_object('account_id', v_cash,   'debit', 100, 'credit',   0),
        jsonb_build_object('account_id', v_equity, 'debit',   0, 'credit', 100)),
      NULL, NULL, 'main', NULL);

    SELECT entry_number INTO v_no FROM public.journal_entries WHERE id = v_je;
    IF v_no IS NULL OR v_no !~ '^JE-[0-9]+$' THEN
      RAISE EXCEPTION 'engine must assign a canonical JE number, got %', COALESCE(v_no, '<null>');
    END IF;
  END $$;

  --------------------------------------------------------------------------
  -- (2) numbering refuses without a business (multi-company isolation)
  --------------------------------------------------------------------------
  DO $$
  DECLARE v_org uuid; v_acct uuid; v_ok boolean := false;
  BEGIN
    SELECT organization_id INTO v_org FROM public.businesses ORDER BY created_at LIMIT 1;
    SELECT id INTO v_acct FROM public.accounts LIMIT 1;
    IF v_org IS NULL OR v_acct IS NULL THEN RETURN; END IF;
    BEGIN
      PERFORM public.post_journal_entry_atomic(
        v_org, NULL, NULL, CURRENT_DATE, 'NO-BIZ', 'no business', 'numbering_test',
        gen_random_uuid(), NULL, false, false,
        jsonb_build_array(
          jsonb_build_object('account_id', v_acct, 'debit', 1, 'credit', 0),
          jsonb_build_object('account_id', v_acct, 'debit', 0, 'credit', 1)),
        NULL, NULL, 'main', NULL);
    EXCEPTION WHEN OTHERS THEN
      v_ok := true;
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'posting without business_id must be refused';
    END IF;
  END $$;

  --------------------------------------------------------------------------
  -- (3) single numbering engine — no second generator anywhere
  --------------------------------------------------------------------------
  DO $$
  DECLARE v_dupes text;
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'get_next_journal_entry_number')
    THEN
      RAISE EXCEPTION 'get_next_journal_entry_number was retired; numbering belongs to generate_next_je_number';
    END IF;

    SELECT string_agg(p.proname, ', ') INTO v_dupes
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname NOT IN ('generate_next_je_number')
       AND pg_get_functiondef(p.oid) ~* 'MAX\s*\(\s*(CASE\s+WHEN\s+)?entry_number';
    IF v_dupes IS NOT NULL THEN
      RAISE EXCEPTION 'second JE numbering engine detected in: %', v_dupes;
    END IF;
  END $$;

  --------------------------------------------------------------------------
  -- (4) entry_number stays engine-owned: NOT NULL, no default, no trigger
  --------------------------------------------------------------------------
  DO $$
  DECLARE v_nullable text; v_default text;
  BEGIN
    SELECT is_nullable, column_default INTO v_nullable, v_default
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'journal_entries'
       AND column_name = 'entry_number';
    IF v_nullable <> 'NO' THEN
      RAISE EXCEPTION 'journal_entries.entry_number must stay NOT NULL';
    END IF;
    IF v_default IS NOT NULL THEN
      RAISE EXCEPTION 'entry_number must not get a default — numbering belongs to the posting engine';
    END IF;
  END $$;

  --------------------------------------------------------------------------
  -- (5) no caller of the posting engine may pass a hand-built number that
  --     bypasses the engine's own numbering authority
  --------------------------------------------------------------------------
  DO $$
  DECLARE v_bad text;
  BEGIN
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND pg_get_functiondef(p.oid) LIKE '%post_journal_entry_atomic%'
       AND pg_get_functiondef(p.oid) ~* '_entry_number\s*:?=\s*''JE-';
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'hardcoded JE number literal in: %', v_bad;
    END IF;
  END $$;

ROLLBACK;
