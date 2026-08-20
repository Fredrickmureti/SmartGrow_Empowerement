-- bank_account_positions — the cash position projection.
--
-- WHAT THIS PROVES
-- `bank_account_positions(_business_id, _as_of)` is the ONLY sanctioned answer
-- to "how much money does this account hold" (ADR-0141). Unlike the reporting
-- RPCs it is SECURITY INVOKER by design: it adds no privilege and leans on RLS
-- over `bank_accounts` / `bank_transactions` / `journal_entry_lines`. That
-- design is only safe if the reliance actually holds, so this file proves:
--
--   1. it is NOT security definer (a definer projection would silently become
--      a privilege seam without a `finance_can_read_org` gate),
--   2. `anon` cannot execute it,
--   3. `bank_accounts` has RLS enabled with a business-scoped SELECT policy —
--      the predicate the projection depends on,
--   4. the arithmetic is reproducible: statement_balance = opening_balance +
--      the account's own bank_transactions up to `_as_of`,
--   5. `_as_of` is honoured: a position as at a past date never includes a
--      later statement line,
--   6. a shared control account nulls `gl_balance` and sets `gl_shared`
--      rather than attributing a shared ledger balance to one account.
--
-- Read-only. Run as `service_role`; it skips loudly rather than passing
-- vacuously when EXECUTE is denied.

DO $$
DECLARE
  v_secdef   boolean;
  v_biz      uuid;
  v_row      record;
  v_expected numeric;
  v_past     date;
  v_checked  int := 0;
  v_eps      numeric := 0.005;
BEGIN
  IF NOT has_function_privilege('public.bank_account_positions(uuid,date)', 'EXECUTE') THEN
    RAISE NOTICE 'SKIPPED: caller has no EXECUTE on bank_account_positions';
    RETURN;
  END IF;

  -- 1. invoker, not definer
  SELECT p.prosecdef INTO v_secdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'bank_account_positions';

  IF v_secdef THEN
    RAISE EXCEPTION 'bank_account_positions is SECURITY DEFINER: it must either stay '
      'SECURITY INVOKER (RLS decides) or carry an explicit finance_can_read_org gate';
  END IF;

  -- 2. anon must not reach it
  IF has_function_privilege('anon', 'public.bank_account_positions(uuid,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can EXECUTE bank_account_positions — cash positions are not public';
  END IF;

  -- 3. the RLS predicate the projection leans on must exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'bank_accounts' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'RLS is disabled on bank_accounts — bank_account_positions would leak '
      'every tenant''s cash position';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'bank_accounts' AND cmd IN ('SELECT', 'ALL')
      AND qual LIKE '%business_id%'
  ) THEN
    RAISE EXCEPTION 'bank_accounts has no business-scoped SELECT policy';
  END IF;

  -- 4/5/6. arithmetic, as-of honouring, shared control account
  FOR v_biz IN
    SELECT DISTINCT business_id FROM public.bank_accounts
    WHERE business_id IS NOT NULL LIMIT 5
  LOOP
    FOR v_row IN
      SELECT * FROM public.bank_account_positions(v_biz, CURRENT_DATE)
    LOOP
      SELECT COALESCE(a.opening_balance, 0) + COALESCE((
                SELECT SUM(CASE
                         WHEN t.transaction_type = 'credit' THEN ABS(t.amount)
                         WHEN t.transaction_type = 'debit'  THEN -ABS(t.amount)
                         ELSE t.amount END)
                FROM public.bank_transactions t
                WHERE t.bank_account_id = v_row.bank_account_id
                  AND t.transaction_date <= CURRENT_DATE
             ), 0)
        INTO v_expected
      FROM public.bank_accounts a WHERE a.id = v_row.bank_account_id;

      IF ABS(COALESCE(v_row.statement_balance, 0) - COALESCE(v_expected, 0)) > v_eps THEN
        RAISE EXCEPTION 'statement_balance for % is % but opening + own lines is %',
          v_row.bank_account_id, v_row.statement_balance, v_expected;
      END IF;

      IF v_row.gl_shared AND v_row.gl_balance IS NOT NULL THEN
        RAISE EXCEPTION 'account % declares a shared control account yet still states a '
          'gl_balance — a shared ledger balance must not be attributed to one account',
          v_row.bank_account_id;
      END IF;

      IF v_row.as_of <> CURRENT_DATE THEN
        RAISE EXCEPTION 'account % echoed as_of % for a CURRENT_DATE request',
          v_row.bank_account_id, v_row.as_of;
      END IF;

      v_checked := v_checked + 1;
    END LOOP;

    -- as-of honouring: a position far in the past cannot include later lines
    SELECT MIN(t.transaction_date) - 1 INTO v_past
    FROM public.bank_transactions t
    JOIN public.bank_accounts a ON a.id = t.bank_account_id
    WHERE a.business_id = v_biz;

    IF v_past IS NOT NULL THEN
      FOR v_row IN SELECT * FROM public.bank_account_positions(v_biz, v_past) LOOP
        SELECT COALESCE(a.opening_balance, 0) INTO v_expected
        FROM public.bank_accounts a WHERE a.id = v_row.bank_account_id;

        IF ABS(COALESCE(v_row.statement_balance, 0) - COALESCE(v_expected, 0)) > v_eps THEN
          RAISE EXCEPTION 'as_of % on account % still counted later statement lines',
            v_past, v_row.bank_account_id;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  RAISE NOTICE 'bank_account_positions: OK (% account positions checked)', v_checked;
END $$;
