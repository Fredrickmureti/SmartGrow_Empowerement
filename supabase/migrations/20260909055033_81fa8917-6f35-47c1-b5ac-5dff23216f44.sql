CREATE OR REPLACE FUNCTION public.mf_generate_schedule(p_loan_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  l public.mf_loans%ROWTYPE;
  v_rate numeric; v_ppy numeric; v_period_rate numeric;
  v_basis text; v_method text;
  v_n integer; v_i integer; v_bal numeric; v_prin numeric; v_int numeric;
  v_flat_interest numeric; v_installment numeric; v_due date;
  v_first_fees numeric := 0; v_paying integer;
BEGIN
  SELECT * INTO l FROM public.mf_loans WHERE id = p_loan_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  IF l.status <> 'pending_disbursement' THEN
    RAISE EXCEPTION 'Schedule can only be generated before disbursement';
  END IF;

  DELETE FROM public.mf_loan_schedule WHERE loan_id = p_loan_id;

  v_method := l.interest_method;
  IF v_method NOT IN ('flat','declining_balance','declining_balance_equal_installments') THEN
    RAISE EXCEPTION 'Unknown interest method "%" on loan %', v_method, l.loan_number;
  END IF;

  -- Legacy spellings are normalised, anything unknown is refused outright.
  v_basis := COALESCE(NULLIF(l.interest_rate_period, ''), 'per_annum');
  IF v_basis = 'per_year' THEN v_basis := 'per_annum'; END IF;
  IF v_basis = 'per_period' THEN v_basis := 'per_installment'; END IF;
  IF v_basis NOT IN ('per_annum','per_month','per_installment','flat_on_principal') THEN
    RAISE EXCEPTION 'Unknown interest rate basis "%" on loan % — the schedule cannot be priced',
      v_basis, l.loan_number;
  END IF;
  IF v_basis = 'flat_on_principal' AND v_method <> 'flat' THEN
    RAISE EXCEPTION 'Rate basis "flat on principal" is only valid with flat interest (loan %)',
      l.loan_number;
  END IF;

  v_ppy := public.mf_periods_per_year(l.repayment_frequency);
  v_rate := COALESCE(l.interest_rate, 0) / 100.0;
  v_period_rate := CASE v_basis
    WHEN 'per_installment'   THEN v_rate
    WHEN 'per_month'         THEN v_rate * 12 / v_ppy
    WHEN 'per_annum'         THEN v_rate / v_ppy
    ELSE NULL END;  -- flat_on_principal has no per-period rate

  v_n := l.term_installments;
  v_paying := GREATEST(v_n - COALESCE(l.grace_period_installments,0), 1);
  v_bal := l.principal;

  v_first_fees := public.mf_loan_fee_total(p_loan_id, 'added_to_first_installment');

  IF v_method = 'flat' THEN
    v_flat_interest := CASE
      WHEN v_basis = 'flat_on_principal' THEN ROUND(l.principal * v_rate, 2)
      ELSE ROUND(l.principal * v_period_rate * v_n, 2) END;
  ELSE
    IF v_period_rate > 0 THEN
      v_installment := ROUND(l.principal * v_period_rate
        / (1 - POWER(1 + v_period_rate, -v_paying)), 2);
    ELSE
      v_installment := ROUND(l.principal / v_paying, 2);
    END IF;
  END IF;

  FOR v_i IN 1..v_n LOOP
    v_due := public.mf_add_period(
      COALESCE(l.first_installment_date, l.expected_disbursement_date, CURRENT_DATE),
      l.repayment_frequency, v_i - 1);

    IF v_i <= COALESCE(l.grace_period_installments,0) THEN
      v_prin := 0;
      v_int := CASE WHEN v_method = 'flat' THEN 0
                    ELSE ROUND(v_bal * v_period_rate, 2) END;
    ELSIF v_method = 'flat' THEN
      v_prin := ROUND(l.principal / v_paying, 2);
      v_int := ROUND(v_flat_interest / v_paying, 2);
      IF v_i = v_n THEN
        v_prin := v_bal;
        -- last paying installment absorbs the rounding residual on interest
        v_int := v_flat_interest - ROUND(v_flat_interest / v_paying, 2) * (v_paying - 1);
      END IF;
    ELSE
      v_int := ROUND(v_bal * v_period_rate, 2);
      v_prin := LEAST(v_installment - v_int, v_bal);
      IF v_i = v_n THEN v_prin := v_bal; END IF;
      IF v_prin < 0 THEN v_prin := 0; END IF;
    END IF;

    INSERT INTO public.mf_loan_schedule (
      business_id, loan_id, installment_no, due_date, opening_balance,
      principal_due, interest_due, fees_due, total_due, closing_balance, is_grace)
    VALUES (l.business_id, l.id, v_i, v_due, v_bal, v_prin, v_int,
      CASE WHEN v_i = 1 THEN v_first_fees ELSE 0 END,
      v_prin + v_int + CASE WHEN v_i = 1 THEN v_first_fees ELSE 0 END,
      v_bal - v_prin, v_i <= COALESCE(l.grace_period_installments,0));

    v_bal := v_bal - v_prin;
  END LOOP;

  RETURN v_n;
END; $function$;