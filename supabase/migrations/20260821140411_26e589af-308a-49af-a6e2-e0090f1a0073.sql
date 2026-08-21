-- Phase 5 (ADR 0136): remove the last silent-parity and currency-literal producers.

CREATE OR REPLACE FUNCTION public.expense_reimburse_direct(
  p_expense_id uuid,
  p_bank_account_id uuid,
  p_payment_date date DEFAULT NULL::date,
  p_reference text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  r public.expenses;
  v_payable uuid;
  v_existing uuid;
  v_je uuid;
  v_date date;
  v_lines jsonb;
  v_doc text;
  v_base text;
  v_ccy text;
  v_book_rate numeric;
  v_settle_rate numeric;
  v_payable_base numeric;
  v_bank_base numeric;
  v_fx_delta numeric;
BEGIN
  r := public._expense_reimbursement_guard(p_expense_id);

  IF r.reimburse_via_payroll THEN
    RAISE EXCEPTION 'Expense is queued for payroll reimbursement; remove it from the payroll queue first'
      USING ERRCODE = '22023';
  END IF;

  IF r.journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'Expense has not been posted to the ledger yet'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.accounts
     WHERE id = p_bank_account_id AND organization_id = r.organization_id
  ) THEN
    RAISE EXCEPTION 'Payment account does not belong to this organization'
      USING ERRCODE = '22023';
  END IF;

  v_payable := public._expense_payable_account(p_expense_id);
  IF v_payable IS NULL THEN
    RAISE EXCEPTION 'Could not resolve the employee payable account from the expense journal entry'
      USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_existing
    FROM public.journal_entries
   WHERE organization_id = r.organization_id
     AND source_type = 'expense'
     AND source_id = p_expense_id
     AND COALESCE(source_subtype, '') = 'reimbursement'
     AND status <> 'voided'
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('journal_entry_id', v_existing, 'idempotent_replay', true);
  END IF;

  v_date := COALESCE(p_payment_date, CURRENT_DATE);
  v_doc  := COALESCE(NULLIF(r.expense_number, ''), 'EXP');

  SELECT upper(base_currency) INTO v_base FROM public.businesses WHERE id = r.business_id;
  IF v_base IS NULL THEN
    RAISE EXCEPTION 'The company has no base currency configured' USING ERRCODE = '22023';
  END IF;
  v_ccy := upper(COALESCE(NULLIF(r.currency, ''), v_base));

  IF v_ccy = v_base THEN
    v_book_rate := 1;
    v_settle_rate := 1;
  ELSE
    -- The liability is relieved at the rate the expense was booked at (ADR 0136 §4).
    v_book_rate := r.exchange_rate;
    IF v_book_rate IS NULL OR v_book_rate <= 0 THEN
      RAISE EXCEPTION 'Expense % carries no booking exchange rate for %; it cannot be settled.', v_doc, v_ccy
        USING ERRCODE = '23514';
    END IF;
    -- The cash leg moves at the payment-date rate, resolved server-side.
    v_settle_rate := public.resolve_exchange_rate(r.organization_id, r.business_id, v_ccy, v_date);
    IF v_settle_rate IS NULL OR v_settle_rate <= 0 THEN
      RAISE EXCEPTION 'No exchange rate on file for % -> % on %. Add one in Currency settings before paying this reimbursement.',
        v_ccy, v_base, v_date USING ERRCODE = '23514';
    END IF;
  END IF;

  v_payable_base := ROUND(r.amount * v_book_rate, 2);
  v_bank_base    := ROUND(r.amount * v_settle_rate, 2);
  v_fx_delta     := ROUND(v_bank_base - v_payable_base, 2);

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', v_payable, 'debit', v_payable_base, 'credit', 0,
      'description', 'Employee reimbursement settled - ' || COALESCE(r.description, ''),
      'business_id', r.business_id, 'branch_id', r.branch_id),
    jsonb_build_object('account_id', p_bank_account_id, 'debit', 0, 'credit', v_bank_base,
      'description', 'Employee reimbursement payment - ' || COALESCE(r.description, ''),
      'business_id', r.business_id, 'branch_id', r.branch_id)
  );

  IF v_fx_delta > 0.005 THEN
    -- Paid more base currency than the payable was booked at: realised loss.
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.resolve_fx_realized_account(r.business_id, 'loss'),
      'debit', v_fx_delta, 'credit', 0,
      'description', 'Realised FX loss on reimbursement of ' || v_doc,
      'business_id', r.business_id, 'branch_id', r.branch_id));
  ELSIF v_fx_delta < -0.005 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.resolve_fx_realized_account(r.business_id, 'gain'),
      'debit', 0, 'credit', ABS(v_fx_delta),
      'description', 'Realised FX gain on reimbursement of ' || v_doc,
      'business_id', r.business_id, 'branch_id', r.branch_id));
  END IF;

  v_je := public.post_journal_entry_atomic(
    r.organization_id, r.business_id,
    public.generate_next_je_number(r.organization_id, r.business_id),
    v_date,
    COALESCE(NULLIF(p_reference, ''), v_doc),
    'Reimbursement of expense ' || v_doc,
    'expense', p_expense_id, auth.uid(), false, false,
    v_lines, v_ccy, v_settle_rate, 'reimbursement', r.branch_id, false, false
  );

  UPDATE public.expenses
     SET reimbursed_at = now(),
         status = 'paid',
         updated_at = now()
   WHERE id = p_expense_id;

  INSERT INTO public.audit_logs
    (organization_id, business_id, user_id, action, entity_type, entity_id, new_values)
  VALUES (r.organization_id, r.business_id, auth.uid(),
          'expense.reimbursement.pay_direct', 'expense', r.id,
          jsonb_build_object('journal_entry_id', v_je, 'bank_account_id', p_bank_account_id,
                             'amount', r.amount, 'payment_date', v_date,
                             'currency', v_ccy, 'booking_rate', v_book_rate,
                             'settlement_rate', v_settle_rate, 'realized_fx', v_fx_delta));

  RETURN jsonb_build_object('success', true, 'journal_entry_id', v_je,
                            'status', 'paid', 'payment_date', v_date,
                            'currency', v_ccy, 'realized_fx', v_fx_delta);
END;
$function$;

COMMENT ON FUNCTION public.expense_reimburse_direct(uuid, uuid, date, text) IS
  'ADR 0136: relieves the employee payable at the expense booking rate, pays cash at the server-resolved payment-date rate and posts the realised FX delta. No parity fallback.';

CREATE OR REPLACE FUNCTION public.pos_payment_session_open(
  p_register_id uuid,
  p_grand_total numeric,
  p_currency text,
  p_idempotency_key text,
  p_tip_amount numeric DEFAULT 0,
  p_cashier_id uuid DEFAULT NULL::uuid,
  p_fx_rate numeric DEFAULT NULL::numeric,
  p_settlement_currency text DEFAULT NULL::text,
  p_tip_policy text DEFAULT 'none'::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_reg  public.pos_registers%ROWTYPE;
  v_row  public.pos_payment_sessions%ROWTYPE;
  v_base text;
  v_ccy  text;
  v_settle_ccy text;
  v_rate numeric;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'pos_payment_session_open: p_idempotency_key is required'
      USING ERRCODE = '22023';
  END IF;

  IF p_fx_rate IS NOT NULL THEN
    RAISE EXCEPTION 'Exchange rates are resolved server-side (ADR 0136); p_fx_rate is not accepted.'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_reg FROM public.pos_registers WHERE id = p_register_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_payment_session_open: unknown register %', p_register_id
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM public.assert_pos_caller_branch_access(v_reg.branch_id);

  -- Idempotent replay: return the existing row for the same key. FX +
  -- tip policy are IMMUTABLE for the life of the session, so we do not
  -- refresh them on replay even if the caller passes new values.
  SELECT * INTO v_row
    FROM public.pos_payment_sessions
   WHERE business_id = v_reg.business_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_row.id;
  END IF;

  SELECT upper(base_currency) INTO v_base FROM public.businesses WHERE id = v_reg.business_id;
  IF v_base IS NULL THEN
    RAISE EXCEPTION 'The company has no base currency configured' USING ERRCODE = '22023';
  END IF;

  v_ccy        := upper(COALESCE(NULLIF(p_currency, ''), v_base));
  v_settle_ccy := upper(COALESCE(NULLIF(p_settlement_currency, ''), v_ccy));

  IF v_ccy = v_settle_ccy THEN
    v_rate := 1;
  ELSIF v_settle_ccy = v_base THEN
    v_rate := public.resolve_exchange_rate(v_reg.organization_id, v_reg.business_id, v_ccy, CURRENT_DATE);
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RAISE EXCEPTION 'No exchange rate on file for % -> % today. Add one in Currency settings before taking payment.',
        v_ccy, v_settle_ccy USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Settling % in % is not supported; the settlement currency must be the company base currency %.',
      v_ccy, v_settle_ccy, v_base USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.pos_payment_sessions
    (register_id, cashier_id, business_id, branch_id, organization_id,
     currency, grand_total, tip_amount, idempotency_key, created_by,
     fx_rate, settlement_currency, tip_policy)
  VALUES
    (v_reg.id, p_cashier_id, v_reg.business_id, v_reg.branch_id, v_reg.organization_id,
     v_ccy, p_grand_total, COALESCE(p_tip_amount,0),
     p_idempotency_key, auth.uid(),
     v_rate, v_settle_ccy,
     COALESCE(p_tip_policy, 'none'))
  RETURNING * INTO v_row;

  PERFORM public._pos_payment_session_emit(
    'pos.payment.session.opened', v_row,
    jsonb_build_object(
      'session_id', v_row.id,
      'register_id', v_row.register_id,
      'grand_total', v_row.grand_total,
      'currency', v_row.currency,
      'settlement_currency', v_row.settlement_currency,
      'fx_rate', v_row.fx_rate,
      'tip_policy', v_row.tip_policy,
      'idempotency_key', v_row.idempotency_key
    )
  );

  RETURN v_row.id;
END;
$function$;

COMMENT ON FUNCTION public.pos_payment_session_open(uuid, numeric, text, text, numeric, uuid, numeric, text, text) IS
  'ADR 0136: session currency defaults to the company base currency and the FX rate is resolved server-side; a caller-supplied p_fx_rate is refused.';

NOTIFY pgrst, 'reload schema';