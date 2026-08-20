-- Bank Reconciliation Statement — the positive leg.
--
-- WHAT THIS PROVES
-- `reporting_isolation_matrix_test.sql` proves the engine REFUSES a foreign
-- organization. Refusal is only half the contract: a report that refuses
-- everything is also "secure". This file proves the engine ANSWERS for its
-- own organization, and that what it answers is a proof rather than a set of
-- numbers that merely look like one:
--
--   1. the caller's own organization is served (no 42501),
--   2. adjusted bank balance − adjusted book balance = the stated residual,
--   3. each side is its own arithmetic:
--        statement balance + deposits in transit − unpresented payments
--          = adjusted bank balance
--        ledger balance + unrecorded receipts − unrecorded charges
--          = adjusted book balance
--   4. every item group's listed items sum to that group's stated total
--      (unless the group declares itself truncated),
--   5. a null book side is reported as an ABSENCE — book balance, adjusted
--      book balance and residual are all null together, never zero.
--
-- Read-only: it calls the engine and inspects the payload. It writes nothing.
-- Run as `service_role` (or as a member of the organization under test);
-- the engine is not executable by `anon` and the file skips loudly if the
-- caller has no EXECUTE privilege.

DO $$
DECLARE
  v_acct     record;
  v_proof    jsonb;
  v_bank     jsonb;
  v_book     jsonb;
  v_grp      jsonb;
  v_sum      numeric;
  v_checked  int := 0;
  v_eps      numeric := 0.005;
BEGIN
  IF NOT has_function_privilege(
       'public.finance_bank_reconciliation_statement(uuid,uuid,date,uuid,uuid)', 'EXECUTE') THEN
    RAISE NOTICE 'SKIPPED: caller has no EXECUTE on finance_bank_reconciliation_statement';
    RETURN;
  END IF;

  FOR v_acct IN
    SELECT id, organization_id, business_id, branch_id
      FROM public.bank_accounts
     ORDER BY created_at
     LIMIT 25
  LOOP
    v_proof := public.finance_bank_reconciliation_statement(
      v_acct.organization_id, v_acct.id, current_date,
      v_acct.business_id, v_acct.branch_id);

    IF v_proof IS NULL THEN
      RAISE EXCEPTION 'engine returned NULL for its own organization (account %)', v_acct.id;
    END IF;

    v_bank := v_proof -> 'bank';
    v_book := v_proof -> 'book';

    -- (3a) bank side arithmetic
    IF abs(
         COALESCE((v_bank ->> 'statement_balance')::numeric, 0)
       + COALESCE((v_bank -> 'deposits_in_transit'  ->> 'total')::numeric, 0)
       - COALESCE((v_bank -> 'unpresented_payments' ->> 'total')::numeric, 0)
       - COALESCE((v_bank ->> 'adjusted_balance')::numeric, 0)
       ) > v_eps THEN
      RAISE EXCEPTION 'bank side does not add up for account %: %', v_acct.id, v_bank;
    END IF;

    -- (5) a null book side is an absence, consistently
    IF (v_book ->> 'gl_balance') IS NULL THEN
      IF (v_book ->> 'adjusted_balance') IS NOT NULL
         OR (v_proof ->> 'residual') IS NOT NULL THEN
        RAISE EXCEPTION
          'account % has no stateable book balance but still states an adjusted balance or residual',
          v_acct.id;
      END IF;
    ELSE
      -- (3b) book side arithmetic
      IF abs(
           (v_book ->> 'gl_balance')::numeric
         + COALESCE((v_book -> 'unrecorded_receipts' ->> 'total')::numeric, 0)
         - COALESCE((v_book -> 'unrecorded_charges'  ->> 'total')::numeric, 0)
         - COALESCE((v_book ->> 'adjusted_balance')::numeric, 0)
         ) > v_eps THEN
        RAISE EXCEPTION 'book side does not add up for account %: %', v_acct.id, v_book;
      END IF;

      -- (2) the two sides and the residual are one statement
      IF abs(
           COALESCE((v_bank ->> 'adjusted_balance')::numeric, 0)
         - (v_book ->> 'adjusted_balance')::numeric
         - COALESCE((v_proof ->> 'residual')::numeric, 0)
         ) > v_eps THEN
        RAISE EXCEPTION
          'adjusted bank − adjusted book ≠ residual for account %: bank=% book=% residual=%',
          v_acct.id,
          v_bank ->> 'adjusted_balance',
          v_book ->> 'adjusted_balance',
          v_proof ->> 'residual';
      END IF;

      IF (v_proof ->> 'in_balance')::boolean
         <> (abs(COALESCE((v_proof ->> 'residual')::numeric, 0)) < 0.01) THEN
        RAISE EXCEPTION 'in_balance contradicts the residual for account %', v_acct.id;
      END IF;
    END IF;

    -- (4) every listed group sums to its stated total
    FOREACH v_grp IN ARRAY ARRAY[
      v_bank -> 'deposits_in_transit',
      v_bank -> 'unpresented_payments',
      v_book -> 'unrecorded_receipts',
      v_book -> 'unrecorded_charges'
    ] LOOP
      CONTINUE WHEN v_grp IS NULL OR COALESCE((v_grp ->> 'truncated')::boolean, false);
      SELECT COALESCE(sum((i ->> 'amount')::numeric), 0)
        INTO v_sum
        FROM jsonb_array_elements(COALESCE(v_grp -> 'items', '[]'::jsonb)) i;
      IF abs(v_sum - COALESCE((v_grp ->> 'total')::numeric, 0)) > v_eps THEN
        RAISE EXCEPTION
          'group "%" lists items summing to % but states % (account %)',
          v_grp ->> 'label', v_sum, v_grp ->> 'total', v_acct.id;
      END IF;
    END LOOP;

    v_checked := v_checked + 1;
  END LOOP;

  IF v_checked = 0 THEN
    RAISE NOTICE 'SKIPPED: no bank accounts visible to this caller';
  ELSE
    RAISE NOTICE 'bank reconciliation proof verified on % account(s)', v_checked;
  END IF;
END $$;
