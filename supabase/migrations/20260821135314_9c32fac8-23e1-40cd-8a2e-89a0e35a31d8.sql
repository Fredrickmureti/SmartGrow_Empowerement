-- ============================================================
-- FX convergence: one rate engine, no silent parity, realized FX at settlement
-- (ADR 0123 posting monopoly, ADR 0136 single FX engine)
-- ============================================================

-- ---------- C1: convert_po_to_bill_atomic must not resolve its own rate ----------
DO $mig$
DECLARE d text; d2 text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'convert_po_to_bill_atomic';
  IF d IS NULL THEN RAISE EXCEPTION 'convert_po_to_bill_atomic is missing'; END IF;

  d2 := regexp_replace(
    d,
    'SELECT base_currency INTO v_company_ccy.*?v_company_total := ROUND\(v_total \* v_rate, 2\);',
    '-- FX is stamped server-side by trg_bills_stamp_currency (ADR 0136).' || E'\n' ||
    '  -- No second lookup, no COALESCE(rate, 1): a missing rate raises there.' || E'\n' ||
    '  v_rate := NULL;' || E'\n' ||
    '  v_company_total := NULL;',
    ''
  );
  IF d2 = d THEN RAISE EXCEPTION 'convert_po_to_bill_atomic: rate lookup block not found'; END IF;
  d := d2;

  d2 := replace(d,
    'RETURNING id INTO v_bill_id;',
    'RETURNING id, currency_rate, company_currency_total INTO v_bill_id, v_rate, v_company_total;');
  IF d2 = d THEN RAISE EXCEPTION 'convert_po_to_bill_atomic: bill RETURNING clause not found'; END IF;
  d := d2;

  EXECUTE d;
END $mig$;

DO $mig$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'convert_po_to_bill_atomic';
  IF v_src ~* 'from\s+public\.exchange_rates' THEN
    RAISE EXCEPTION 'convert_po_to_bill_atomic still reads the rate book directly';
  END IF;
  IF v_src ~* 'COALESCE\(v_rate,\s*1\)' THEN
    RAISE EXCEPTION 'convert_po_to_bill_atomic still falls back to parity';
  END IF;
END $mig$;

-- ---------- C4: settlement rates are resolved server-side only ----------
DO $mig$
DECLARE d text; d2 text;
BEGIN
  -- AR receipts
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'record_multi_invoice_payment';
  IF d IS NULL THEN RAISE EXCEPTION 'record_multi_invoice_payment is missing'; END IF;

  d2 := replace(d,
    'IF _exchange_rate IS NOT NULL AND _exchange_rate <= 0 THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Exchange rate must be positive.'';',
    'IF _exchange_rate IS NOT NULL THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Settlement exchange rates are resolved server-side (ADR 0136); _exchange_rate is not accepted.'' USING ERRCODE = ''22023'';');
  IF d2 = d THEN RAISE EXCEPTION 'record_multi_invoice_payment: rate-argument guard not found'; END IF;
  d := d2;

  d2 := replace(d,
    'v_settle_rate := COALESCE(_exchange_rate,' || E'\n' ||
    '      public.resolve_exchange_rate(_org_id, _business_id, v_currency, _payment_date));',
    'v_settle_rate := public.resolve_exchange_rate(_org_id, _business_id, v_currency, _payment_date);');
  IF d2 = d THEN RAISE EXCEPTION 'record_multi_invoice_payment: settle rate expression not found'; END IF;
  EXECUTE d2;

  -- AP payments
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'record_multi_bill_payment';
  IF d IS NULL THEN RAISE EXCEPTION 'record_multi_bill_payment is missing'; END IF;

  d2 := replace(d,
    'BEGIN' || E'\n' || '  v_credit_account_id := _credit_account_id;',
    'BEGIN' || E'\n' ||
    '  IF _exchange_rate IS NOT NULL THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Settlement exchange rates are resolved server-side (ADR 0136); _exchange_rate is not accepted.'' USING ERRCODE = ''22023'';' || E'\n' ||
    '  END IF;' || E'\n' ||
    '  v_credit_account_id := _credit_account_id;');
  IF d2 = d THEN RAISE EXCEPTION 'record_multi_bill_payment: prologue not found'; END IF;
  d := d2;

  d2 := replace(d,
    'v_settle_rate := COALESCE(_exchange_rate,' || E'\n' ||
    '      public.resolve_exchange_rate(_org_id, v_business_id, v_currency, _payment_date));',
    'v_settle_rate := public.resolve_exchange_rate(_org_id, v_business_id, v_currency, _payment_date);');
  IF d2 = d THEN RAISE EXCEPTION 'record_multi_bill_payment: settle rate expression not found'; END IF;
  EXECUTE d2;
END $mig$;

-- ---------- C2: realized FX when a customer credit settles an invoice ----------
CREATE OR REPLACE FUNCTION public.apply_credit_to_invoice_atomic(
  _org_id uuid, _business_id uuid, _credit_note_id uuid, _invoice_id uuid,
  _amount numeric, _applied_by uuid, _notes text, _branch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cn public.credit_notes%ROWTYPE;
  v_inv public.invoices%ROWTYPE;
  v_available numeric;
  v_invoice_balance numeric;
  v_application_id uuid;
  v_je_id uuid;
  v_branch uuid;
  v_credit_liab uuid; v_ar uuid;
  v_balance_id uuid;
  v_new_inv_paid numeric; v_new_inv_status text;
  v_base text;
  v_cn_rate numeric; v_inv_rate numeric;
  v_credit_base numeric; v_ar_base numeric; v_fx_delta numeric;
  v_lines jsonb;
BEGIN
  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Application amount must be positive';
  END IF;

  SELECT * INTO v_cn FROM public.credit_notes
   WHERE id = _credit_note_id AND organization_id = _org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit note not found'; END IF;
  IF v_cn.status <> 'issued' THEN
    RAISE EXCEPTION 'Credit note is not in issued status (current: %)', v_cn.status;
  END IF;
  IF v_cn.business_id IS DISTINCT FROM _business_id THEN
    RAISE EXCEPTION 'Credit note business mismatch';
  END IF;

  SELECT * INTO v_inv FROM public.invoices
   WHERE id = _invoice_id AND organization_id = _org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_inv.business_id IS DISTINCT FROM _business_id THEN
    RAISE EXCEPTION 'Invoice business mismatch';
  END IF;
  IF v_cn.contact_id IS DISTINCT FROM v_inv.contact_id THEN
    RAISE EXCEPTION 'Customer credit may only be applied to the same customer''s invoices';
  END IF;

  SELECT upper(NULLIF(base_currency, '')) INTO v_base
    FROM public.businesses WHERE id = _business_id;
  IF v_base IS NULL THEN
    RAISE EXCEPTION 'Company % has no base currency configured', _business_id;
  END IF;

  -- Credit and invoice must be denominated alike; cross-currency application
  -- is a conversion, not a settlement, and is not supported.
  IF upper(COALESCE(v_cn.currency, v_base)) IS DISTINCT FROM upper(COALESCE(v_inv.currency, v_base)) THEN
    RAISE EXCEPTION 'Credit note is in % but invoice % is in %; cross-currency application is not supported',
      upper(COALESCE(v_cn.currency, v_base)), v_inv.invoice_number, upper(COALESCE(v_inv.currency, v_base));
  END IF;

  -- Each side is relieved at the rate it was booked at. A foreign document with
  -- no booking rate is a defect, never a 1:1 (ADR 0136).
  IF upper(COALESCE(v_cn.currency, v_base)) = v_base THEN
    v_cn_rate := 1; v_inv_rate := 1;
  ELSE
    v_cn_rate := v_cn.exchange_rate;
    v_inv_rate := v_inv.exchange_rate;
    IF v_cn_rate IS NULL OR v_cn_rate <= 0 THEN
      RAISE EXCEPTION 'Credit note % has no booking exchange rate on file', v_cn.credit_note_number
        USING ERRCODE = '23514';
    END IF;
    IF v_inv_rate IS NULL OR v_inv_rate <= 0 THEN
      RAISE EXCEPTION 'Invoice % has no booking exchange rate on file', v_inv.invoice_number
        USING ERRCODE = '23514';
    END IF;
  END IF;

  v_branch := COALESCE(v_inv.branch_id, v_cn.branch_id, _branch_id);

  v_balance_id := public.customer_credit_balance_id(_org_id, _business_id, v_cn.contact_id, v_cn.currency);
  SELECT balance INTO v_available FROM public.customer_credit_balances WHERE id = v_balance_id;
  IF _amount > COALESCE(v_available, 0) + 0.01 THEN
    RAISE EXCEPTION 'Amount (%) exceeds available customer credit (%)', _amount, COALESCE(v_available, 0);
  END IF;

  v_invoice_balance := COALESCE(v_inv.total, 0) - COALESCE(v_inv.amount_paid, 0);
  IF _amount > v_invoice_balance + 0.01 THEN
    RAISE EXCEPTION 'Amount (%) exceeds invoice balance (%)', _amount, v_invoice_balance;
  END IF;

  IF NOT public.is_period_open(_business_id, CURRENT_DATE) THEN
    RAISE EXCEPTION 'accounting period is closed for %', CURRENT_DATE;
  END IF;

  v_credit_liab := public.customer_credit_account(_business_id);
  v_ar := public.compensation_account(_business_id, 'accounts_receivable');

  INSERT INTO public.credit_note_applications (
    credit_note_id, invoice_id, amount, applied_by, notes, business_id, branch_id
  ) VALUES (
    _credit_note_id, _invoice_id, _amount, COALESCE(_applied_by, auth.uid()), _notes, _business_id, v_branch
  ) RETURNING id INTO v_application_id;

  v_credit_base := ROUND(_amount * v_cn_rate, 2);
  v_ar_base     := ROUND(_amount * v_inv_rate, 2);
  v_fx_delta    := ROUND(v_credit_base - v_ar_base, 2);

  -- Lines are already base currency (each leg carries its own historical rate),
  -- so the posting engine must not convert them again.
  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', v_credit_liab, 'debit', v_credit_base, 'credit', 0,
      'description', 'Customer credit consumed: ' || v_cn.credit_note_number,
      'contact_id', v_cn.contact_id),
    jsonb_build_object('account_id', v_ar, 'debit', 0, 'credit', v_ar_base,
      'description', 'Receivable settled by credit: ' || v_inv.invoice_number,
      'contact_id', v_cn.contact_id)
  );

  IF v_fx_delta > 0.005 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.resolve_fx_realized_account(_business_id, 'gain'),
      'debit', 0, 'credit', v_fx_delta,
      'description', 'Realised FX gain on credit application ' || v_cn.credit_note_number));
  ELSIF v_fx_delta < -0.005 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.resolve_fx_realized_account(_business_id, 'loss'),
      'debit', ABS(v_fx_delta), 'credit', 0,
      'description', 'Realised FX loss on credit application ' || v_cn.credit_note_number));
  END IF;

  v_je_id := public.post_journal_entry_atomic(
    _org_id := _org_id,
    _business_id := _business_id,
    _entry_number := public.generate_next_je_number(_org_id, _business_id),
    _entry_date := CURRENT_DATE,
    _reference := 'CNA-' || v_cn.credit_note_number || '-' || v_inv.invoice_number,
    _description := 'Apply customer credit ' || v_cn.credit_note_number || ' to invoice ' || v_inv.invoice_number,
    _source_type := 'credit_application',
    _source_id := v_application_id,
    _created_by := COALESCE(_applied_by, auth.uid()),
    _is_closing := false,
    _is_adjusting := false,
    _lines := v_lines,
    _currency := NULL,
    _exchange_rate := NULL,
    _amounts_in_document_currency := false,
    _source_subtype := NULL,
    _branch_id := v_branch
  );

  INSERT INTO public.customer_credit_movements (
    organization_id, business_id, branch_id, contact_id, balance_id,
    kind, amount, currency, credit_note_id, invoice_id, journal_entry_id, created_by, notes
  ) VALUES (
    _org_id, _business_id, v_branch, v_cn.contact_id, v_balance_id,
    'apply', _amount, v_cn.currency, _credit_note_id, _invoice_id, v_je_id,
    COALESCE(_applied_by, auth.uid()), _notes
  );

  UPDATE public.credit_notes
     SET amount_applied = COALESCE(amount_applied, 0) + _amount,
         status = CASE WHEN COALESCE(amount_applied, 0) + _amount >= total
                       THEN 'applied'::credit_note_status ELSE 'issued'::credit_note_status END,
         updated_at = now()
   WHERE id = _credit_note_id;

  v_new_inv_paid := COALESCE(v_inv.amount_paid, 0) + _amount;
  v_new_inv_status := CASE
    WHEN v_new_inv_paid >= COALESCE(v_inv.total, 0) THEN 'paid'
    WHEN v_new_inv_paid > 0 THEN 'partial' ELSE 'sent' END;

  UPDATE public.invoices
     SET amount_paid = v_new_inv_paid, status = v_new_inv_status::invoice_status
   WHERE id = _invoice_id;

  RETURN jsonb_build_object(
    'application_id', v_application_id,
    'journal_entry_id', v_je_id,
    'branch_id', v_branch,
    'invoice_new_status', v_new_inv_status,
    'invoice_amount_paid', v_new_inv_paid,
    'fx_delta', v_fx_delta
  );
END;
$function$;

-- ---------- C3a: customer refund — realized FX, no currency literal ----------
CREATE OR REPLACE FUNCTION public.refund_customer_atomic(
  _source text, _source_id uuid, _bank_account_id uuid, _amount numeric,
  _refund_date date, _reason_code payment_reversal_reason, _reason_text text,
  _payment_method text, _reference text, _client_request_id text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_credit  public.credit_notes%ROWTYPE;
  v_org_id uuid; v_business_id uuid; v_contact_id uuid; v_currency text;
  v_drain_account uuid;
  v_je_id uuid; v_refund_id uuid; v_event_id uuid;
  v_post_date date;
  v_balance_id uuid; v_available numeric;
  v_branch uuid;
  v_base text; v_book_rate numeric; v_settle_rate numeric;
  v_drain_base numeric; v_bank_base numeric; v_fx_delta numeric;
  v_lines jsonb;
BEGIN
  IF _source NOT IN ('payment','credit_note') THEN RAISE EXCEPTION 'source must be payment or credit_note'; END IF;
  IF _source_id IS NULL THEN RAISE EXCEPTION 'source_id required'; END IF;
  IF _bank_account_id IS NULL THEN RAISE EXCEPTION 'bank_account_id required'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;

  v_post_date := COALESCE(_refund_date, CURRENT_DATE);

  IF _source = 'payment' THEN
    SELECT * INTO v_payment FROM public.payments WHERE id = _source_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'source payment % not found', _source_id; END IF;
    IF COALESCE(v_payment.outstanding_amount, 0) < _amount THEN
      RAISE EXCEPTION 'refund exceeds outstanding amount on payment (% < %)', v_payment.outstanding_amount, _amount;
    END IF;
    v_org_id := v_payment.organization_id; v_business_id := v_payment.business_id;
    v_contact_id := v_payment.contact_id;
    v_branch := v_payment.branch_id;
  ELSE
    SELECT * INTO v_credit FROM public.credit_notes WHERE id = _source_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'source credit_note % not found', _source_id; END IF;
    IF v_credit.status NOT IN ('issued','applied','refunded') THEN
      RAISE EXCEPTION 'only an issued credit note can be refunded (current: %)', v_credit.status;
    END IF;
    v_org_id := v_credit.organization_id; v_business_id := v_credit.business_id;
    v_contact_id := v_credit.contact_id;
    v_branch := v_credit.branch_id;
  END IF;

  -- A refund drains the liability the source parked the money in: customer
  -- credit for credit notes, customer deposits for unapplied payments.
  IF _source = 'credit_note' THEN
    v_drain_account := public.customer_credit_account(v_business_id);
  ELSE
    v_drain_account := public.compensation_account(v_business_id, 'customer_deposits');
  END IF;

  IF v_business_id IS NULL OR NOT public.user_can_access_business(auth.uid(), v_business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_business_id USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_period_open(v_business_id, v_post_date) THEN
    RAISE EXCEPTION 'accounting period is closed for %', v_post_date;
  END IF;

  IF _client_request_id IS NOT NULL THEN
    IF _source = 'payment' THEN
      SELECT id INTO v_event_id FROM public.payment_reversal_events
       WHERE payment_id = v_payment.id AND op = 'refund' AND client_request_id = _client_request_id;
      IF v_event_id IS NOT NULL THEN RETURN v_event_id; END IF;
    END IF;
    SELECT id INTO v_refund_id FROM public.customer_refunds WHERE client_request_id = _client_request_id;
    IF v_refund_id IS NOT NULL THEN RETURN v_refund_id; END IF;
  END IF;

  -- The base currency is the company's, never a literal (ADR 0136).
  SELECT upper(NULLIF(base_currency, '')) INTO v_base
    FROM public.businesses WHERE id = v_business_id;
  IF v_base IS NULL THEN
    RAISE EXCEPTION 'Company % has no base currency configured', v_business_id;
  END IF;

  IF _source = 'credit_note' THEN
    v_currency := upper(COALESCE(NULLIF(v_credit.currency, ''), v_base));
  ELSE
    -- Customer payments are recorded in the base currency; there is no
    -- payment-level denomination to carry.
    v_currency := v_base;
  END IF;

  IF v_currency = v_base THEN
    v_book_rate := 1; v_settle_rate := 1;
  ELSE
    v_book_rate := v_credit.exchange_rate;
    IF v_book_rate IS NULL OR v_book_rate <= 0 THEN
      RAISE EXCEPTION 'Credit note % has no booking exchange rate on file', v_credit.credit_note_number
        USING ERRCODE = '23514';
    END IF;
    v_settle_rate := public.require_exchange_rate(v_org_id, v_business_id, v_currency, v_post_date);
  END IF;

  IF _source = 'credit_note' THEN
    v_balance_id := public.customer_credit_balance_id(v_org_id, v_business_id, v_contact_id, v_currency);
    SELECT balance INTO v_available FROM public.customer_credit_balances WHERE id = v_balance_id;
    IF _amount > COALESCE(v_available, 0) + 0.01 THEN
      RAISE EXCEPTION 'refund (%) exceeds available customer credit (%)', _amount, COALESCE(v_available, 0);
    END IF;
  END IF;

  INSERT INTO public.customer_refunds (
    organization_id, business_id, branch_id, contact_id,
    source_payment_id, source_credit_note_id,
    amount, currency, refund_date, bank_account_id,
    payment_method, reference, reason, status, created_by, client_request_id
  ) VALUES (
    v_org_id, v_business_id, v_branch, v_contact_id,
    CASE WHEN _source='payment' THEN _source_id ELSE NULL END,
    CASE WHEN _source='credit_note' THEN _source_id ELSE NULL END,
    _amount, v_currency, v_post_date, _bank_account_id,
    _payment_method, _reference, _reason_text, 'posted', auth.uid(), _client_request_id
  ) RETURNING id INTO v_refund_id;

  v_drain_base := ROUND(_amount * v_book_rate, 2);
  v_bank_base  := ROUND(_amount * v_settle_rate, 2);
  v_fx_delta   := ROUND(v_drain_base - v_bank_base, 2);

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', v_drain_account, 'debit', v_drain_base, 'credit', 0,
      'description', 'Customer refund — ' || _source, 'contact_id', v_contact_id),
    jsonb_build_object('account_id', _bank_account_id, 'debit', 0, 'credit', v_bank_base,
      'description', 'Customer refund paid out', 'contact_id', v_contact_id)
  );

  IF v_fx_delta > 0.005 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.resolve_fx_realized_account(v_business_id, 'gain'),
      'debit', 0, 'credit', v_fx_delta,
      'description', 'Realised FX gain on ' || v_currency || ' customer refund'));
  ELSIF v_fx_delta < -0.005 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.resolve_fx_realized_account(v_business_id, 'loss'),
      'debit', ABS(v_fx_delta), 'credit', 0,
      'description', 'Realised FX loss on ' || v_currency || ' customer refund'));
  END IF;

  v_je_id := public.post_journal_entry_atomic(
    _org_id := v_org_id,
    _business_id := v_business_id,
    _entry_number := public.generate_next_je_number(v_org_id, v_business_id),
    _entry_date := v_post_date,
    _reference := COALESCE(_reference, 'REFUND'),
    _description := 'Customer refund — ' || _source,
    _source_type := 'customer_refund',
    _source_id := v_refund_id,
    _created_by := auth.uid(),
    _is_closing := false,
    _is_adjusting := false,
    _lines := v_lines,
    _currency := NULL,
    _exchange_rate := NULL,
    _amounts_in_document_currency := false,
    _source_subtype := NULL,
    _branch_id := v_branch
  );

  UPDATE public.customer_refunds SET journal_entry_id = v_je_id WHERE id = v_refund_id;

  IF _source = 'payment' THEN
    UPDATE public.payments
       SET outstanding_amount = COALESCE(outstanding_amount, 0) - _amount
     WHERE id = _source_id;
  ELSE
    INSERT INTO public.customer_credit_movements (
      organization_id, business_id, branch_id, contact_id, balance_id,
      kind, amount, currency, credit_note_id, refund_id, journal_entry_id, created_by, notes
    ) VALUES (
      v_org_id, v_business_id, v_branch, v_contact_id, v_balance_id,
      'refund', _amount, v_currency, _source_id, v_refund_id, v_je_id, auth.uid(), _reason_text
    );

    UPDATE public.credit_notes
       SET refund_amount = COALESCE(refund_amount, 0) + _amount,
           refund_date = v_post_date,
           refund_method = _payment_method,
           status = CASE WHEN COALESCE(refund_amount, 0) + _amount + COALESCE(amount_applied, 0) >= total
                         THEN 'refunded'::credit_note_status ELSE status END,
           updated_at = now()
     WHERE id = _source_id;
  END IF;

  RETURN v_refund_id;
END $function$;

-- ---------- C3b: vendor refund — realized FX ----------
CREATE OR REPLACE FUNCTION public.refund_from_vendor_atomic(
  _vendor_credit_note_id uuid, _bank_account_id uuid, _amount numeric,
  _refund_date date DEFAULT NULL::date, _reason_text text DEFAULT NULL::text,
  _payment_method text DEFAULT NULL::text, _reference text DEFAULT NULL::text,
  _client_request_id text DEFAULT NULL::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_vcn public.vendor_credit_notes%ROWTYPE;
  v_post_date date; v_balance_id uuid; v_available numeric;
  v_credit_asset uuid; v_je_id uuid; v_refund_id uuid;
  v_base text; v_currency text; v_book_rate numeric; v_settle_rate numeric;
  v_credit_base numeric; v_bank_base numeric; v_fx_delta numeric;
  v_lines jsonb;
BEGIN
  IF _bank_account_id IS NULL THEN RAISE EXCEPTION 'bank_account_id required'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;

  SELECT * INTO v_vcn FROM public.vendor_credit_notes WHERE id = _vendor_credit_note_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vendor credit note % not found', _vendor_credit_note_id; END IF;
  IF v_vcn.status NOT IN ('confirmed','applied') THEN
    RAISE EXCEPTION 'only an issued vendor credit note can be refunded (current: %)', v_vcn.status;
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_vcn.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_vcn.business_id USING ERRCODE = '42501';
  END IF;

  v_post_date := COALESCE(_refund_date, CURRENT_DATE);
  IF NOT public.is_period_open(v_vcn.business_id, v_post_date) THEN
    RAISE EXCEPTION 'accounting period is closed for %', v_post_date;
  END IF;

  IF _client_request_id IS NOT NULL THEN
    SELECT id INTO v_refund_id FROM public.vendor_refunds WHERE client_request_id = _client_request_id;
    IF v_refund_id IS NOT NULL THEN RETURN v_refund_id; END IF;
  END IF;

  SELECT upper(NULLIF(base_currency, '')) INTO v_base
    FROM public.businesses WHERE id = v_vcn.business_id;
  IF v_base IS NULL THEN
    RAISE EXCEPTION 'Company % has no base currency configured', v_vcn.business_id;
  END IF;
  v_currency := upper(COALESCE(NULLIF(v_vcn.currency, ''), v_base));

  IF v_currency = v_base THEN
    v_book_rate := 1; v_settle_rate := 1;
  ELSE
    v_book_rate := v_vcn.exchange_rate;
    IF v_book_rate IS NULL OR v_book_rate <= 0 THEN
      RAISE EXCEPTION 'Vendor credit note % has no booking exchange rate on file', v_vcn.credit_note_number
        USING ERRCODE = '23514';
    END IF;
    v_settle_rate := public.require_exchange_rate(
      v_vcn.organization_id, v_vcn.business_id, v_currency, v_post_date);
  END IF;

  v_balance_id := public.vendor_credit_balance_id(
    v_vcn.organization_id, v_vcn.business_id, v_vcn.vendor_id, v_vcn.currency);
  SELECT balance INTO v_available FROM public.vendor_credit_balances WHERE id = v_balance_id;
  IF _amount > COALESCE(v_available, 0) + 0.01 THEN
    RAISE EXCEPTION 'refund (%) exceeds available vendor credit (%)', _amount, COALESCE(v_available, 0);
  END IF;

  v_credit_asset := public.vendor_credit_account(v_vcn.business_id);

  INSERT INTO public.vendor_refunds (
    organization_id, business_id, branch_id, vendor_id, source_vendor_credit_note_id,
    amount, currency, refund_date, bank_account_id, payment_method, reference, reason,
    status, created_by, client_request_id
  ) VALUES (
    v_vcn.organization_id, v_vcn.business_id, v_vcn.branch_id, v_vcn.vendor_id, _vendor_credit_note_id,
    _amount, v_currency, v_post_date, _bank_account_id, _payment_method, _reference, _reason_text,
    'posted', auth.uid(), _client_request_id
  ) RETURNING id INTO v_refund_id;

  v_bank_base   := ROUND(_amount * v_settle_rate, 2);
  v_credit_base := ROUND(_amount * v_book_rate, 2);
  v_fx_delta    := ROUND(v_bank_base - v_credit_base, 2);

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', _bank_account_id, 'debit', v_bank_base, 'credit', 0,
      'description', 'Vendor refund received', 'contact_id', v_vcn.vendor_id),
    jsonb_build_object('account_id', v_credit_asset, 'debit', 0, 'credit', v_credit_base,
      'description', 'Vendor credit refunded: ' || v_vcn.credit_note_number,
      'contact_id', v_vcn.vendor_id)
  );

  IF v_fx_delta > 0.005 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.resolve_fx_realized_account(v_vcn.business_id, 'gain'),
      'debit', 0, 'credit', v_fx_delta,
      'description', 'Realised FX gain on ' || v_currency || ' vendor refund'));
  ELSIF v_fx_delta < -0.005 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.resolve_fx_realized_account(v_vcn.business_id, 'loss'),
      'debit', ABS(v_fx_delta), 'credit', 0,
      'description', 'Realised FX loss on ' || v_currency || ' vendor refund'));
  END IF;

  v_je_id := public.post_journal_entry_atomic(
    _org_id := v_vcn.organization_id,
    _business_id := v_vcn.business_id,
    _entry_number := public.generate_next_je_number(v_vcn.organization_id, v_vcn.business_id),
    _entry_date := v_post_date,
    _reference := COALESCE(_reference, 'VREFUND'),
    _description := 'Vendor refund — ' || v_vcn.credit_note_number,
    _source_type := 'vendor_refund',
    _source_id := v_refund_id,
    _created_by := auth.uid(),
    _is_closing := false,
    _is_adjusting := false,
    _lines := v_lines,
    _currency := NULL,
    _exchange_rate := NULL,
    _amounts_in_document_currency := false,
    _source_subtype := NULL,
    _branch_id := v_vcn.branch_id
  );

  UPDATE public.vendor_refunds SET journal_entry_id = v_je_id, updated_at = now() WHERE id = v_refund_id;

  INSERT INTO public.vendor_credit_movements (
    organization_id, business_id, branch_id, vendor_id, balance_id,
    kind, amount, currency, vendor_credit_note_id, refund_id, journal_entry_id, created_by, notes
  ) VALUES (
    v_vcn.organization_id, v_vcn.business_id, v_vcn.branch_id, v_vcn.vendor_id, v_balance_id,
    'refund', _amount, v_currency, _vendor_credit_note_id, v_refund_id, v_je_id, auth.uid(), _reason_text
  );

  RETURN v_refund_id;
END $function$;