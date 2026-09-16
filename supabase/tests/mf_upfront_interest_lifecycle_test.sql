-- mf_upfront_interest_lifecycle_test.sql
--
-- End-to-end proof of the client's upfront-interest model over a full loan
-- life: 10,000 gross / 2,000 interest / 12 weekly instalments, interest
-- withheld at payout and earned as each instalment is settled.
--
-- Asserted:
--   1. Schedule carries the gross principal only (10,000), interest 0.
--   2. Payout hands over 8,000 and parks 2,000 of deferred interest.
--   3. Every receipt that settles an instalment recognises exactly one
--      interest slice, in the same transaction, never twice.
--   4. After twelve receipts: loan closed, nothing outstanding, interest
--      income exactly 2,000, deferred interest exactly 0, principal
--      receivable 0, net cash +2,000 (10,000 in less 8,000 out).
--   5. Reversing the last receipt unwinds its interest slice, and the
--      payout cannot be reversed while a live slice stands.
--
-- No production data is touched: everything runs inside a rolled-back block.

BEGIN;

  --------------------------------------------------------------------------
  -- (0) Structure the behaviour depends on
  --------------------------------------------------------------------------
  DO $$
  DECLARE v_missing text;
  BEGIN
    SELECT string_agg(t || '.' || c, ', ') INTO v_missing
    FROM (VALUES
      ('mf_loan_product_versions','interest_recognition'),
      ('mf_loans','interest_recognition'),
      ('mf_deferred_interest_releases','repayment_id')
    ) AS req(t,c)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=req.t AND column_name=req.c);
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'missing columns: %', v_missing;
    END IF;

    SELECT string_agg(fn, ', ') INTO v_missing
    FROM (VALUES
      ('mf_recognise_repayment_interest'),
      ('mf_release_deferred_interest'),
      ('mf_release_deferred_interest_due')
    ) AS req(fn)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_proc
       WHERE proname = req.fn AND pronamespace = 'public'::regnamespace);
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'missing functions: %', v_missing;
    END IF;

    -- Recognition must be wired into the receipt, not left dormant.
    PERFORM 1 FROM pg_proc
     WHERE proname = 'mf_record_repayment' AND pronamespace = 'public'::regnamespace
       AND prosrc LIKE '%mf_recognise_repayment_interest%';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mf_record_repayment no longer recognises interest on receipt';
    END IF;

    -- The due-date runner must not touch loans that recognise on repayment.
    PERFORM 1 FROM pg_proc
     WHERE proname = 'mf_release_deferred_interest_due' AND pronamespace = 'public'::regnamespace
       AND prosrc LIKE '%on_schedule_date%';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the due-date runner is not restricted to on_schedule_date loans';
    END IF;
  END $$;

  --------------------------------------------------------------------------
  -- (1)-(5) Full lifecycle on a throwaway loan
  --------------------------------------------------------------------------
  DO $$
  DECLARE
    v_user uuid; v_officer uuid; v_biz uuid; v_branch uuid; v_client uuid;
    v_ver uuid; v_prod uuid; v_ccy text; v_app uuid;
    v_loan uuid; v_disb uuid; v_rep uuid; v_last_rep uuid;
    v_prin numeric; v_int numeric; v_net numeric; v_up numeric;
    v_due numeric; v_released numeric; v_slices integer;
    v_cash uuid; v_pr uuid; v_ii uuid; v_di uuid;
    v_status text; v_caught boolean := false;
    i integer;

  BEGIN
    -- Approver and originator must be two different people: the segregation
    -- of duties guard refuses a decision taken on one's own submission.
    SELECT ur.user_id INTO v_user FROM public.user_roles ur WHERE ur.role = 'admin' LIMIT 1;
    SELECT ur.user_id INTO v_officer FROM public.user_roles ur
     WHERE ur.user_id <> v_user ORDER BY ur.user_id LIMIT 1;
    SELECT b.id INTO v_biz FROM public.businesses b LIMIT 1;
    SELECT br.id INTO v_branch FROM public.branches br WHERE br.business_id = v_biz LIMIT 1;
    SELECT c.id INTO v_client FROM public.mf_clients c WHERE c.business_id = v_biz LIMIT 1;
    SELECT v.id, v.product_id INTO v_ver, v_prod
      FROM public.mf_loan_product_versions v
     WHERE v.business_id = v_biz AND v.is_published AND v.effective_from <= CURRENT_DATE
     ORDER BY v.version_no DESC LIMIT 1;
    IF v_user IS NULL OR v_officer IS NULL OR v_biz IS NULL OR v_branch IS NULL
       OR v_client IS NULL OR v_ver IS NULL THEN
      RAISE NOTICE 'fixtures unavailable; skipping lifecycle checks';
      RETURN;
    END IF;
    SELECT COALESCE(b.base_currency, 'KES') INTO v_ccy FROM public.businesses b WHERE b.id = v_biz;

    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_user, 'role', 'authenticated')::text, true);

    v_pr   := public.mf_resolve_account(v_biz, v_branch, 'principal_receivable');
    v_ii   := public.mf_resolve_account(v_biz, v_branch, 'interest_income');
    v_di   := public.mf_resolve_account(v_biz, v_branch, 'deferred_interest');
    v_cash := public.mf_resolve_account(v_biz, v_branch, public.mf_method_mapping_key('cash'));

    -- (0b) A loan only exists behind an approved application. Walk the
    -- application through its real stages rather than forcing a status.
    INSERT INTO public.mf_loan_applications (
      business_id, branch_id, client_id, product_id, product_version_id,
      requested_amount, requested_term_installments, status)
    VALUES (v_biz, v_branch, v_client, v_prod, v_ver, 10000, 12, 'draft')
    RETURNING id INTO v_app;

    UPDATE public.mf_loan_applications
       SET status = 'submitted', submitted_by = v_officer
     WHERE id = v_app;

    INSERT INTO public.mf_application_assessments (business_id, application_id, assessed_by)
    VALUES (v_biz, v_app, v_officer);

    UPDATE public.mf_loan_applications SET status = 'under_review' WHERE id = v_app;
    UPDATE public.mf_loan_applications
       SET status = 'approved', approved_amount = 10000, approved_term_installments = 12
     WHERE id = v_app;

    INSERT INTO public.mf_loans (
      business_id, branch_id, loan_number, client_id, application_id,
      product_id, product_version_id,
      currency_code, principal, term_installments, repayment_frequency,
      interest_method, interest_rate, interest_rate_period, interest_collection,
      interest_recognition, fees, expected_disbursement_date, first_installment_date,
      status, created_by)
    VALUES (v_biz, v_branch, 'TEST-UPFRONT-LIFE', v_client, v_app,
      v_prod, v_ver,
      v_ccy, 10000, 12, 'weekly', 'flat', 20, 'flat_on_principal', 'deducted_upfront',
      'on_repayment', '[]'::jsonb, CURRENT_DATE, CURRENT_DATE + 7,
      'pending_disbursement', v_officer)
    RETURNING id INTO v_loan;

    -- (1) Schedule: gross principal only
    PERFORM public.mf_generate_schedule(v_loan);
    SELECT ROUND(SUM(principal_due),2), ROUND(SUM(interest_due),2), COUNT(*)
      INTO v_prin, v_int, i FROM public.mf_loan_schedule WHERE loan_id = v_loan;
    IF v_prin <> 10000 OR v_int <> 0 OR i <> 12 THEN
      RAISE EXCEPTION 'schedule wrong: principal %, interest %, rows %', v_prin, v_int, i;
    END IF;

    -- (2) Payout: 8,000 out, 2,000 parked
    v_disb := public.mf_disburse_loan(v_loan, CURRENT_DATE, 10000, 'cash');
    SELECT net_amount, upfront_interest INTO v_net, v_up
      FROM public.mf_loan_disbursements WHERE id = v_disb;
    IF v_net <> 8000 OR v_up <> 2000 THEN
      RAISE EXCEPTION 'payout wrong: net %, upfront %', v_net, v_up;
    END IF;

    -- (3) Twelve receipts, each settling one instalment exactly
    FOR i IN 1..12 LOOP
      SELECT ROUND(total_outstanding, 2) INTO v_due
        FROM public.mf_loan_installment_status
       WHERE loan_id = v_loan AND installment_no = i;
      IF COALESCE(v_due, 0) <= 0 THEN
        RAISE EXCEPTION 'instalment % had nothing outstanding before its receipt', i;
      END IF;

      v_rep := public.mf_record_repayment(v_loan, CURRENT_DATE, v_due, 'cash', NULL);
      v_last_rep := v_rep;

      SELECT COUNT(*) INTO v_slices
        FROM public.mf_deferred_interest_releases
       WHERE loan_id = v_loan AND reversed_at IS NULL;
      IF v_slices <> i THEN
        RAISE EXCEPTION 'after receipt % there are % interest slices, expected %',
          i, v_slices, i;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM public.mf_deferred_interest_releases
                      WHERE loan_id = v_loan AND installment_no = i
                        AND repayment_id = v_rep AND reversed_at IS NULL) THEN
        RAISE EXCEPTION 'instalment % was not recognised against its own receipt', i;
      END IF;
    END LOOP;

    -- (4) Closing position
    SELECT ROUND(COALESCE(SUM(amount),0),2) INTO v_released
      FROM public.mf_deferred_interest_releases
     WHERE loan_id = v_loan AND reversed_at IS NULL;
    IF v_released <> 2000 THEN
      RAISE EXCEPTION 'interest recognised over the life is %, expected 2000', v_released;
    END IF;

    IF EXISTS (SELECT 1 FROM public.mf_loan_installment_status
                WHERE loan_id = v_loan AND ROUND(total_outstanding,2) > 0) THEN
      RAISE EXCEPTION 'instalments remain outstanding after twelve full receipts';
    END IF;

    SELECT status INTO v_status FROM public.mf_loans WHERE id = v_loan;
    IF v_status <> 'closed' THEN
      RAISE EXCEPTION 'loan did not close after full repayment (status %)', v_status;
    END IF;

    -- Ledger tie-out across every journal this loan produced
    CREATE TEMP TABLE _mf_life_lines ON COMMIT DROP AS
      SELECT jel.account_id, jel.debit, jel.credit
        FROM public.journal_entry_lines jel
        JOIN public.mf_event_postings p ON p.journal_entry_id = jel.journal_entry_id
        JOIN public.mf_loan_events e ON e.id = p.loan_event_id
       WHERE e.loan_id = v_loan;

    IF (SELECT ROUND(SUM(debit) - SUM(credit), 2) FROM _mf_life_lines) <> 0 THEN
      RAISE EXCEPTION 'the loan journals do not balance in aggregate';
    END IF;
    IF (SELECT ROUND(COALESCE(SUM(debit - credit),0),2) FROM _mf_life_lines
         WHERE account_id = v_pr) <> 0 THEN
      RAISE EXCEPTION 'principal receivable did not return to zero';
    END IF;
    IF (SELECT ROUND(COALESCE(SUM(credit - debit),0),2) FROM _mf_life_lines
         WHERE account_id = v_di) <> 0 THEN
      RAISE EXCEPTION 'deferred interest did not return to zero';
    END IF;
    IF (SELECT ROUND(COALESCE(SUM(credit - debit),0),2) FROM _mf_life_lines
         WHERE account_id = v_ii) <> 2000 THEN
      RAISE EXCEPTION 'interest income over the life is not 2,000';
    END IF;
    IF (SELECT ROUND(COALESCE(SUM(debit - credit),0),2) FROM _mf_life_lines
         WHERE account_id = v_cash) <> 2000 THEN
      RAISE EXCEPTION 'net cash movement is not +2,000 (10,000 in less 8,000 out)';
    END IF;

    -- (5) Reversing the last receipt unwinds its slice
    PERFORM public.mf_reverse_repayment(v_last_rep, 'lifecycle test');
    IF EXISTS (SELECT 1 FROM public.mf_deferred_interest_releases
                WHERE repayment_id = v_last_rep AND reversed_at IS NULL) THEN
      RAISE EXCEPTION 'reversing a receipt left its interest slice standing';
    END IF;
    SELECT ROUND(COALESCE(SUM(amount),0),2) INTO v_released
      FROM public.mf_deferred_interest_releases
     WHERE loan_id = v_loan AND reversed_at IS NULL;
    IF v_released <> 2000 - 166.63 AND v_released <> 2000 - 166.67 THEN
      RAISE EXCEPTION 'interest after reversing the last receipt is %, expected the final slice removed', v_released;
    END IF;

    -- The payout stays locked while recognised interest is still standing
    BEGIN
      PERFORM public.mf_reverse_disbursement(v_disb, 'lifecycle test');
    EXCEPTION WHEN OTHERS THEN v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'the payout was reversed while recognised interest stood';
    END IF;

    RAISE NOTICE 'mf_upfront_interest_lifecycle_test: all assertions passed';
  END $$;

ROLLBACK;
