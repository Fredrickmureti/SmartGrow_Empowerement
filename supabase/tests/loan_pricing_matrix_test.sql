-- loan_pricing_matrix_test.sql
-- Deterministic pricing matrix for mf_generate_schedule on a KES 10,000 loan.
--
-- What this pins:
--   1. Every stored interest rate basis (per_annum, per_month, per_installment,
--      flat_on_principal) prices distinctly and predictably.
--   2. Flat and declining-balance methods both reconcile:
--        sum(principal_due) = principal
--        sum(total_due)     = principal + sum(interest_due) + sum(fees_due)
--      with no unexplained residual.
--   3. Grace installments defer principal and (for flat) interest into the
--      remaining paying installments; nothing is waived or capitalised.
--   4. Fee models: deducted_from_disbursement never touches the schedule;
--      added_to_first_installment lands on installment 1 only.
--   5. Unknown / contradictory configurations are refused by the engine.
--   6. Installment dates follow the repayment frequency.
--
-- No production data is touched — everything runs inside a rolled-back block.

BEGIN;

DO $$
DECLARE
  v_biz    uuid;
  v_branch uuid;
  v_prod   uuid := gen_random_uuid();
  v_ver    uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_loan   uuid;
  v_n      integer;

  v_principal   constant numeric := 10000;
  v_first_due   constant date    := DATE '2026-01-05';

  r record;
  v_sum_prin numeric;
  v_sum_int  numeric;
  v_sum_fee  numeric;
  v_sum_tot  numeric;
  v_cnt      integer;
  v_err      text;

  -- case matrix
  c record;
BEGIN
  SELECT id INTO v_biz FROM public.businesses ORDER BY created_at LIMIT 1;
  SELECT id INTO v_branch FROM public.branches WHERE business_id = v_biz ORDER BY created_at LIMIT 1;
  IF v_biz IS NULL OR v_branch IS NULL THEN
    RAISE EXCEPTION 'No business/branch available to run the pricing matrix';
  END IF;

  INSERT INTO public.mf_clients (id, business_id, branch_id, client_number, full_name, status)
  VALUES (v_client, v_biz, v_branch, 'TEST-PRICING-'||substr(v_client::text,1,8),
          'Pricing Matrix Test Client', 'active');

  INSERT INTO public.mf_loan_products (id, business_id, code, name, status)
  VALUES (v_prod, v_biz, 'TESTPRICE', 'Pricing matrix product', 'active');

  INSERT INTO public.mf_loan_product_versions (
    id, business_id, product_id, version_no, currency_code,
    min_amount, max_amount, min_term_installments, max_term_installments,
    repayment_frequency, interest_method, interest_rate, interest_rate_period,
    grace_period_installments, fees, penalty_rate, penalty_basis,
    effective_from, is_published)
  VALUES (v_ver, v_biz, v_prod, 1, 'KES',
    1000, 1000000, 1, 60, 'monthly', 'flat', 12, 'per_annum',
    0, '[]'::jsonb, 0, 'overdue_installment', DATE '2020-01-01', true);

  --------------------------------------------------------------------------
  -- Priced cases. expected_interest NULL = declining balance, reconcile only.
  --------------------------------------------------------------------------
  FOR c IN
    SELECT * FROM (VALUES
      -- label, method, rate, basis, frequency, term, grace, fees, exp_interest, exp_fee
      ('flat / 12% per annum / monthly / 6',      'flat', 12,  'per_annum',         'monthly',  6,  0, '[]',                                                                   600.00, 0.00),
      ('flat / 20% flat on principal / weekly/12','flat', 20,  'flat_on_principal', 'weekly',   12, 0, '[]',                                                                  2000.00, 0.00),
      ('flat / 1% per installment / weekly / 10', 'flat', 1,   'per_installment',   'weekly',   10, 0, '[]',                                                                  1000.00, 0.00),
      ('flat / 2% per month / weekly / 13',       'flat', 2,   'per_month',         'weekly',   13, 0, '[]',                                                                   600.00, 0.00),
      ('flat / 0% / biweekly / 8',                'flat', 0,   'per_annum',         'biweekly', 8,  0, '[]',                                                                     0.00, 0.00),
      ('flat / 12% p.a. / monthly / 6 / grace 2', 'flat', 12,  'per_annum',         'monthly',  6,  2, '[]',                                                                   600.00, 0.00),
      ('flat / 5% deducted fee / monthly / 6',    'flat', 12,  'per_annum',         'monthly',  6,  0, '[{"name":"Processing","basis":"percent_of_principal","value":5,"collection":"deducted_from_disbursement"}]', 600.00, 0.00),
      ('flat / 300 added fee / monthly / 6',      'flat', 12,  'per_annum',         'monthly',  6,  0, '[{"name":"Admin","basis":"fixed","value":300,"collection":"added_to_first_installment"}]',                    600.00, 300.00),
      ('flat / 10% p.a. / daily / 30',            'flat', 10,  'per_annum',         'daily',    30, 0, '[]',                                                                    82.19, 0.00),
      ('declining / 12% p.a. / monthly / 6',      'declining_balance', 12, 'per_annum', 'monthly', 6, 0, '[]',                                                                  NULL,   0.00),
      ('declining / 0% / monthly / 5',            'declining_balance', 0,  'per_annum', 'monthly', 5, 0, '[]',                                                                  0.00,   0.00),
      ('declining / 2% per month / weekly / 12',  'declining_balance', 2,  'per_month', 'weekly',  12, 0, '[]',                                                                 NULL,   0.00),
      ('declining / 12% p.a. / monthly/6/grace 1','declining_balance', 12, 'per_annum', 'monthly', 6, 1, '[]',                                                                  NULL,   0.00)
    ) AS t(label, method, rate, basis, freq, term, grace, fees, exp_interest, exp_fee)
  LOOP
    v_loan := gen_random_uuid();
    INSERT INTO public.mf_loans (
      id, business_id, branch_id, loan_number, client_id, product_id, product_version_id,
      currency_code, principal, term_installments, repayment_frequency,
      interest_method, interest_rate, interest_rate_period, grace_period_installments,
      fees, penalty_rate, penalty_basis, expected_disbursement_date,
      first_installment_date, status, lineage_kind, application_id)
    VALUES (
      v_loan, v_biz, v_branch, 'TESTLN-'||substr(v_loan::text,1,8), v_client, v_prod, v_ver,
      'KES', v_principal, c.term, c.freq,
      c.method, c.rate, c.basis, c.grace,
      c.fees::jsonb, 0, 'overdue_installment', v_first_due,
      v_first_due, 'pending_disbursement', 'new', gen_random_uuid());

    v_n := public.mf_generate_schedule(v_loan);

    SELECT count(*), ROUND(SUM(principal_due),2), ROUND(SUM(interest_due),2),
           ROUND(SUM(fees_due),2), ROUND(SUM(total_due),2)
      INTO v_cnt, v_sum_prin, v_sum_int, v_sum_fee, v_sum_tot
      FROM public.mf_loan_schedule WHERE loan_id = v_loan;

    IF v_cnt <> c.term OR v_n <> c.term THEN
      RAISE EXCEPTION '[%] installment count % (engine %) <> term %', c.label, v_cnt, v_n, c.term;
    END IF;
    IF v_sum_prin <> v_principal THEN
      RAISE EXCEPTION '[%] principal reconciliation failed: % <> %', c.label, v_sum_prin, v_principal;
    END IF;
    IF v_sum_tot <> v_sum_prin + v_sum_int + v_sum_fee THEN
      RAISE EXCEPTION '[%] residual: total % <> % + % + %', c.label, v_sum_tot, v_sum_prin, v_sum_int, v_sum_fee;
    END IF;
    IF c.exp_interest IS NOT NULL AND v_sum_int <> c.exp_interest THEN
      RAISE EXCEPTION '[%] interest % <> expected %', c.label, v_sum_int, c.exp_interest;
    END IF;
    IF v_sum_fee <> c.exp_fee THEN
      RAISE EXCEPTION '[%] scheduled fees % <> expected %', c.label, v_sum_fee, c.exp_fee;
    END IF;

    -- fees only ever land on installment 1
    IF EXISTS (SELECT 1 FROM public.mf_loan_schedule
                WHERE loan_id = v_loan AND installment_no > 1 AND COALESCE(fees_due,0) <> 0) THEN
      RAISE EXCEPTION '[%] fees leaked past installment 1', c.label;
    END IF;

    -- closing balance must land exactly on zero
    IF (SELECT ROUND(closing_balance,2) FROM public.mf_loan_schedule
          WHERE loan_id = v_loan ORDER BY installment_no DESC LIMIT 1) <> 0 THEN
      RAISE EXCEPTION '[%] final closing balance is not zero', c.label;
    END IF;

    -- grace installments carry no principal and are flagged
    IF c.grace > 0 THEN
      IF EXISTS (SELECT 1 FROM public.mf_loan_schedule
                  WHERE loan_id = v_loan AND installment_no <= c.grace
                    AND (COALESCE(principal_due,0) <> 0 OR is_grace IS NOT TRUE)) THEN
        RAISE EXCEPTION '[%] grace installments carry principal or are unflagged', c.label;
      END IF;
    END IF;

    -- first due date and cadence
    IF (SELECT due_date FROM public.mf_loan_schedule WHERE loan_id = v_loan AND installment_no = 1) <> v_first_due THEN
      RAISE EXCEPTION '[%] first due date is not the contractual first installment date', c.label;
    END IF;
    IF (SELECT due_date FROM public.mf_loan_schedule WHERE loan_id = v_loan AND installment_no = 2)
       <> public.mf_add_period(v_first_due, c.freq, 1) THEN
      RAISE EXCEPTION '[%] second due date does not follow the % cadence', c.label, c.freq;
    END IF;

    -- fee model split
    IF public.mf_loan_fee_total(v_loan, 'added_to_first_installment') <> c.exp_fee THEN
      RAISE EXCEPTION '[%] added-to-first-installment fee total mismatch', c.label;
    END IF;

    RAISE NOTICE '[OK] % -> principal % interest % fees % total %',
      c.label, v_sum_prin, v_sum_int, v_sum_fee, v_sum_tot;
  END LOOP;

  --------------------------------------------------------------------------
  -- Deducted fee: reduces cash out, never the obligation
  --------------------------------------------------------------------------
  v_loan := gen_random_uuid();
  INSERT INTO public.mf_loans (
    id, business_id, branch_id, loan_number, client_id, product_id, product_version_id,
    currency_code, principal, term_installments, repayment_frequency,
    interest_method, interest_rate, interest_rate_period, grace_period_installments,
    fees, penalty_rate, penalty_basis, expected_disbursement_date,
    first_installment_date, status, lineage_kind, application_id)
  VALUES (v_loan, v_biz, v_branch, 'TESTLN-FEE', v_client, v_prod, v_ver,
    'KES', v_principal, 6, 'monthly', 'flat', 12, 'per_annum', 0,
    '[{"name":"Processing","basis":"percent_of_principal","value":5,"collection":"deducted_from_disbursement"}]'::jsonb,
    0, 'overdue_installment', v_first_due, v_first_due, 'pending_disbursement', 'new', gen_random_uuid());
  PERFORM public.mf_generate_schedule(v_loan);

  IF public.mf_loan_fee_total(v_loan, 'deducted_from_disbursement') <> 500.00 THEN
    RAISE EXCEPTION 'deducted fee should be 5%% of 10,000 = 500';
  END IF;
  IF (SELECT ROUND(SUM(total_due),2) FROM public.mf_loan_schedule WHERE loan_id = v_loan) <> 10600.00 THEN
    RAISE EXCEPTION 'a deducted fee must not change the client obligation';
  END IF;

  --------------------------------------------------------------------------
  -- Refusals
  --------------------------------------------------------------------------
  -- (a) rate basis the engine cannot price
  BEGIN
    v_loan := gen_random_uuid();
    INSERT INTO public.mf_loans (
      id, business_id, branch_id, loan_number, client_id, product_id, product_version_id,
      currency_code, principal, term_installments, repayment_frequency,
      interest_method, interest_rate, interest_rate_period, status, lineage_kind, application_id,
      first_installment_date)
    VALUES (v_loan, v_biz, v_branch, 'TESTLN-BAD1', v_client, v_prod, v_ver,
      'KES', v_principal, 6, 'monthly', 'flat', 12, 'per_fortnight',
      'pending_disbursement', 'new', gen_random_uuid(), v_first_due);
    RAISE EXCEPTION 'an unknown rate basis must be rejected by the database';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- (b) flat_on_principal is only meaningful with flat interest
  BEGIN
    v_loan := gen_random_uuid();
    INSERT INTO public.mf_loans (
      id, business_id, branch_id, loan_number, client_id, product_id, product_version_id,
      currency_code, principal, term_installments, repayment_frequency,
      interest_method, interest_rate, interest_rate_period, status, lineage_kind, application_id,
      first_installment_date)
    VALUES (v_loan, v_biz, v_branch, 'TESTLN-BAD2', v_client, v_prod, v_ver,
      'KES', v_principal, 6, 'monthly', 'declining_balance', 12, 'flat_on_principal',
      'pending_disbursement', 'new', gen_random_uuid(), v_first_due);
    BEGIN
      PERFORM public.mf_generate_schedule(v_loan);
      RAISE EXCEPTION 'flat_on_principal with declining balance must be refused';
    EXCEPTION WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      IF v_err NOT LIKE '%flat on principal%' THEN RAISE; END IF;
    END;
  END;

  -- (c) product version cannot have grace >= shortest allowed term
  BEGIN
    INSERT INTO public.mf_loan_product_versions (
      business_id, product_id, version_no, currency_code, min_amount, max_amount,
      min_term_installments, max_term_installments, repayment_frequency,
      interest_method, interest_rate, interest_rate_period, grace_period_installments,
      effective_from)
    VALUES (v_biz, v_prod, 99, 'KES', 1000, 100000, 4, 12, 'weekly',
      'flat', 10, 'per_annum', 4, DATE '2021-01-01');
    RAISE EXCEPTION 'grace >= min term must be rejected';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- (d) two versions of one product cannot share an effective date
  BEGIN
    INSERT INTO public.mf_loan_product_versions (
      business_id, product_id, version_no, currency_code, min_amount, max_amount,
      min_term_installments, max_term_installments, repayment_frequency,
      interest_method, interest_rate, interest_rate_period, effective_from)
    VALUES (v_biz, v_prod, 98, 'KES', 1000, 100000, 4, 12, 'weekly',
      'flat', 10, 'per_annum', DATE '2020-01-01');
    RAISE EXCEPTION 'duplicate effective_from must be rejected';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  RAISE NOTICE 'loan pricing matrix: ALL CASES PASS';
END $$;

ROLLBACK;
