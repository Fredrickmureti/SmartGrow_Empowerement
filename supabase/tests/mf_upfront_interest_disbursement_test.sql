-- mf_upfront_interest_disbursement_test.sql
--
-- Pins the two product-level options added for upfront interest and a
-- processing fee paid by the client at disbursement:
--   1. Structural: interest_collection on product versions + loans, the
--      flat-only constraint, the disbursement component columns, and the
--      mf_loan_upfront_interest helper.
--   2. Behavioural, on a throwaway loan (10,000 / 20% flat on principal /
--      200 fee paid by the client):
--        - schedule carries principal only, interest 0
--        - upfront interest = 2,000
--        - payout: 8,000 handed over, fee 200 received, 0 netted
--        - journal: Dr principal 10,000 + Dr cash 200
--                   Cr interest income 2,000, Cr fee income 200, Cr cash 8,000
--   3. Control: the same loan with the default collection is unchanged —
--      interest 2,000 on the schedule, 10,000 paid out, no upfront interest.
--   4. Contractual terms stay frozen after disbursement.
--   5. The disbursement role guard is still in place.
--
-- No production data is touched: everything runs inside a rolled-back block.

BEGIN;

  --------------------------------------------------------------------------
  -- (1) Structure
  --------------------------------------------------------------------------
  DO $$
  DECLARE v_missing text;
  BEGIN
    SELECT string_agg(t || '.' || c, ', ') INTO v_missing
    FROM (VALUES
      ('mf_loan_product_versions','interest_collection'),
      ('mf_loans','interest_collection'),
      ('mf_loan_disbursements','upfront_interest'),
      ('mf_loan_disbursements','fees_paid_by_client')
    ) AS req(t,c)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=req.t AND column_name=req.c);
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'missing columns: %', v_missing;
    END IF;

    PERFORM 1 FROM pg_proc
     WHERE proname='mf_loan_upfront_interest' AND pronamespace='public'::regnamespace;
    IF NOT FOUND THEN RAISE EXCEPTION 'mf_loan_upfront_interest missing'; END IF;

    PERFORM 1 FROM pg_constraint
     WHERE conname='mf_loans_interest_collection_chk'
       AND conrelid='public.mf_loans'::regclass;
    IF NOT FOUND THEN RAISE EXCEPTION 'interest_collection check missing on mf_loans'; END IF;

    PERFORM 1 FROM pg_proc
     WHERE proname='mf_disburse_loan' AND pronamespace='public'::regnamespace
       AND prosrc LIKE '%not authorised to disburse loans%';
    IF NOT FOUND THEN RAISE EXCEPTION 'mf_disburse_loan lost its role guard'; END IF;
  END $$;

  --------------------------------------------------------------------------
  -- (2)-(4) Behaviour on a throwaway loan
  --------------------------------------------------------------------------
  DO $$
  DECLARE
    v_user uuid; v_biz uuid; v_branch uuid; v_client uuid;
    v_ver uuid; v_prod uuid; v_ccy text;
    v_loan uuid; v_loan2 uuid; v_disb uuid; v_je uuid;
    v_fees jsonb;
    v_prin numeric; v_int numeric; v_up numeric;
    v_net numeric; v_client_fee numeric; v_deducted numeric;
    v_dr numeric; v_cr numeric; v_caught boolean := false;
    v_cash uuid; v_pr uuid; v_ii uuid; v_fi uuid;
  BEGIN
    SELECT ur.user_id INTO v_user FROM public.user_roles ur WHERE ur.role = 'admin' LIMIT 1;
    SELECT b.id INTO v_biz FROM public.businesses b LIMIT 1;
    SELECT br.id INTO v_branch FROM public.branches br WHERE br.business_id = v_biz LIMIT 1;
    SELECT c.id INTO v_client FROM public.mf_clients c WHERE c.business_id = v_biz LIMIT 1;
    SELECT v.id, v.product_id INTO v_ver, v_prod
      FROM public.mf_loan_product_versions v LIMIT 1;
    IF v_user IS NULL OR v_biz IS NULL OR v_client IS NULL OR v_ver IS NULL THEN
      RAISE NOTICE 'fixtures unavailable; skipping behavioural checks';
      RETURN;
    END IF;
    SELECT COALESCE(b.base_currency, 'KES') INTO v_ccy FROM public.businesses b WHERE b.id = v_biz;

    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_user, 'role', 'authenticated')::text, true);

    v_fees := jsonb_build_array(jsonb_build_object(
      'name','Processing fee','basis','fixed','value',200,'collection','paid_at_disbursement'));

    INSERT INTO public.mf_loans (
      business_id, branch_id, loan_number, client_id, product_id, product_version_id,
      currency_code, principal, term_installments, repayment_frequency,
      interest_method, interest_rate, interest_rate_period, interest_collection,
      fees, expected_disbursement_date, first_installment_date, status, created_by)
    VALUES (v_biz, v_branch, 'TEST-UPFRONT-1', v_client, v_prod, v_ver,
      v_ccy, 10000, 4, 'monthly', 'flat', 20, 'flat_on_principal', 'deducted_upfront',
      v_fees, CURRENT_DATE, CURRENT_DATE + 30, 'pending_disbursement', v_user)
    RETURNING id INTO v_loan;

    -- Schedule: principal only
    PERFORM public.mf_generate_schedule(v_loan);
    SELECT ROUND(SUM(principal_due),2), ROUND(SUM(interest_due),2)
      INTO v_prin, v_int FROM public.mf_loan_schedule WHERE loan_id = v_loan;
    IF v_prin <> 10000 OR v_int <> 0 THEN
      RAISE EXCEPTION 'upfront schedule wrong: principal %, interest %', v_prin, v_int;
    END IF;

    v_up := public.mf_loan_upfront_interest(v_loan);
    IF v_up <> 2000 THEN RAISE EXCEPTION 'upfront interest expected 2000, got %', v_up; END IF;

    -- Disbursement components
    v_disb := public.mf_disburse_loan(v_loan, CURRENT_DATE, 10000, 'cash');
    SELECT net_amount, fees_deducted, upfront_interest, fees_paid_by_client
      INTO v_net, v_deducted, v_up, v_client_fee
      FROM public.mf_loan_disbursements WHERE id = v_disb;
    IF v_net <> 8000 OR v_deducted <> 0 OR v_up <> 2000 OR v_client_fee <> 200 THEN
      RAISE EXCEPTION 'payout components wrong: net %, deducted %, upfront %, client fee %',
        v_net, v_deducted, v_up, v_client_fee;
    END IF;

    -- Journal: balanced, and each component in its own account
    SELECT p.journal_entry_id INTO v_je
      FROM public.mf_event_postings p
      JOIN public.mf_loan_events e ON e.id = p.loan_event_id
     WHERE e.loan_id = v_loan AND e.event_type = 'loan_disbursed';
    IF v_je IS NULL THEN RAISE EXCEPTION 'disbursement was not posted'; END IF;

    SELECT ROUND(SUM(debit),2), ROUND(SUM(credit),2) INTO v_dr, v_cr
      FROM public.journal_entry_lines WHERE journal_entry_id = v_je;
    IF v_dr <> v_cr OR v_dr <> 10200 THEN
      RAISE EXCEPTION 'disbursement journal not balanced at 10,200: Dr % / Cr %', v_dr, v_cr;
    END IF;

    v_pr   := public.mf_resolve_account(v_biz, v_branch, 'principal_receivable');
    v_ii   := public.mf_resolve_account(v_biz, v_branch, 'interest_income');
    v_fi   := public.mf_resolve_account(v_biz, v_branch, 'fee_income');
    v_cash := public.mf_resolve_account(v_biz, v_branch, public.mf_method_mapping_key('cash'));

    IF (SELECT ROUND(COALESCE(SUM(debit - credit),0),2) FROM public.journal_entry_lines
         WHERE journal_entry_id = v_je AND account_id = v_pr) <> 10000 THEN
      RAISE EXCEPTION 'principal receivable is not 10,000';
    END IF;
    IF (SELECT ROUND(COALESCE(SUM(credit - debit),0),2) FROM public.journal_entry_lines
         WHERE journal_entry_id = v_je AND account_id = v_ii) <> 2000 THEN
      RAISE EXCEPTION 'interest income is not 2,000';
    END IF;
    IF (SELECT ROUND(COALESCE(SUM(credit - debit),0),2) FROM public.journal_entry_lines
         WHERE journal_entry_id = v_je AND account_id = v_fi) <> 200 THEN
      RAISE EXCEPTION 'fee income is not 200';
    END IF;
    IF (SELECT ROUND(COALESCE(SUM(credit - debit),0),2) FROM public.journal_entry_lines
         WHERE journal_entry_id = v_je AND account_id = v_cash) <> 7800 THEN
      RAISE EXCEPTION 'net cash out of the till is not 7,800';
    END IF;

    -- Frozen terms: the disbursed loan cannot be re-priced
    BEGIN
      UPDATE public.mf_loans SET interest_collection = 'with_installments' WHERE id = v_loan;
    EXCEPTION WHEN OTHERS THEN v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'interest collection changed on a disbursed loan';
    END IF;

    -- Control: default collection behaves exactly as before
    INSERT INTO public.mf_loans (
      business_id, branch_id, loan_number, client_id, product_id, product_version_id,
      currency_code, principal, term_installments, repayment_frequency,
      interest_method, interest_rate, interest_rate_period, interest_collection,
      fees, expected_disbursement_date, first_installment_date, status, created_by)
    VALUES (v_biz, v_branch, 'TEST-UPFRONT-2', v_client, v_prod, v_ver,
      v_ccy, 10000, 4, 'monthly', 'flat', 20, 'flat_on_principal', 'with_installments',
      '[]'::jsonb, CURRENT_DATE, CURRENT_DATE + 30, 'pending_disbursement', v_user)
    RETURNING id INTO v_loan2;

    PERFORM public.mf_generate_schedule(v_loan2);
    SELECT ROUND(SUM(principal_due),2), ROUND(SUM(interest_due),2)
      INTO v_prin, v_int FROM public.mf_loan_schedule WHERE loan_id = v_loan2;
    IF v_prin <> 10000 OR v_int <> 2000 THEN
      RAISE EXCEPTION 'default schedule changed: principal %, interest %', v_prin, v_int;
    END IF;
    IF public.mf_loan_upfront_interest(v_loan2) <> 0 THEN
      RAISE EXCEPTION 'default loan reported upfront interest';
    END IF;

    v_disb := public.mf_disburse_loan(v_loan2, CURRENT_DATE, 10000, 'cash');
    SELECT net_amount, upfront_interest, fees_paid_by_client
      INTO v_net, v_up, v_client_fee
      FROM public.mf_loan_disbursements WHERE id = v_disb;
    IF v_net <> 10000 OR v_up <> 0 OR v_client_fee <> 0 THEN
      RAISE EXCEPTION 'default payout changed: net %, upfront %, client fee %',
        v_net, v_up, v_client_fee;
    END IF;

    RAISE NOTICE 'mf_upfront_interest_disbursement_test: all assertions passed';
  END $$;

ROLLBACK;
