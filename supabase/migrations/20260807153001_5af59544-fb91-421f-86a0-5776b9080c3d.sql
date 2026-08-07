-- ADR 0131 Phase B — give customer credit its own liability account so the
-- customer_credit_balances ledger ties out to a single GL account, separate
-- from customer prepayments/deposits.

INSERT INTO public.system_account_roles (role_key, label, description, category, required_account_type, is_mandatory, sort_order)
VALUES ('customer_credit', 'Customer Credits',
        'Unapplied customer credit created by credit notes; kept separate from customer prepayments.',
        'core', 'liability', false, 205)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO public.account_role_eligibility (role_key, account_type, detail_type, priority)
VALUES ('customer_credit', 'liability', 'customer_deposits', 1)
ON CONFLICT DO NOTHING;

DO $seed$
DECLARE
  r RECORD;
  v_new_id uuid;
BEGIN
  FOR r IN
    SELECT a.business_id, a.organization_id, a.parent_id
    FROM public.accounts a
    WHERE a.system_role = 'customer_deposits'
      AND NOT EXISTS (
        SELECT 1 FROM public.accounts b
        WHERE b.business_id = a.business_id AND b.system_role = 'customer_credit')
  LOOP
    v_new_id := public.upsert_system_account(
      _organization_id := r.organization_id,
      _business_id := r.business_id,
      _system_role := 'customer_credit',
      _account_type := 'liability',
      _detail_type := 'customer_deposits',
      _suggested_code := '2215',
      _suggested_name := 'Customer Credits',
      _description := 'Unapplied customer credit arising from credit notes',
      _parent_id := r.parent_id,
      _is_header := false
    );

    INSERT INTO public.default_account_settings (
      organization_id, business_id, setting_key, account_id, source
    ) VALUES (r.organization_id, r.business_id, 'customer_credit', v_new_id, 'manual')
    ON CONFLICT DO NOTHING;
  END LOOP;
END;
$seed$;

-- Resolver with a safe fallback: businesses that have not configured the new
-- key keep posting to customer_deposits rather than erroring.
CREATE OR REPLACE FUNCTION public.customer_credit_account(_business_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_id uuid;
BEGIN
  SELECT account_id INTO v_id
  FROM public.default_account_settings
  WHERE business_id = _business_id AND setting_key = 'customer_credit';
  IF v_id IS NULL THEN
    v_id := public.compensation_account(_business_id, 'customer_deposits');
  END IF;
  RETURN v_id;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.customer_credit_account(uuid) TO authenticated;

-- Swap the three customer-side writers onto the dedicated account.
CREATE OR REPLACE FUNCTION public.issue_credit_note_atomic(_credit_note_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_cn public.credit_notes%ROWTYPE;
  v_inv public.invoices%ROWTYPE;
  v_open_balance numeric := 0;
  v_to_ar numeric := 0;
  v_to_credit numeric := 0;
  v_ar uuid; v_rev uuid; v_tax uuid; v_credit_liab uuid;
  v_lines jsonb;
  v_je_id uuid;
  v_balance_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = _credit_note_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit note % not found', _credit_note_id; END IF;
  IF v_cn.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft credit notes can be issued (current: %)', v_cn.status;
  END IF;
  IF v_cn.business_id IS NULL OR NOT public.user_can_access_business(auth.uid(), v_cn.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_cn.business_id USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_period_open(v_cn.business_id, v_cn.issue_date) THEN
    RAISE EXCEPTION 'accounting period is closed for %', v_cn.issue_date;
  END IF;

  PERFORM public.assert_no_existing_source_posting(v_cn.organization_id, 'credit_note', _credit_note_id, NULL);

  v_ar  := public.compensation_account(v_cn.business_id, 'accounts_receivable');
  v_rev := public.compensation_account(v_cn.business_id, 'sales_revenue');
  v_credit_liab := public.customer_credit_account(v_cn.business_id);
  IF COALESCE(v_cn.tax_amount, 0) > 0 THEN
    v_tax := public.compensation_account(v_cn.business_id, 'output_tax');
  END IF;

  -- Split: a credit note reduces the receivable only up to the linked
  -- invoice's still-open balance. Anything beyond that (settled invoice, or
  -- no invoice at all) becomes customer credit — a liability, never AR.
  IF v_cn.invoice_id IS NOT NULL THEN
    SELECT * INTO v_inv FROM public.invoices WHERE id = v_cn.invoice_id FOR UPDATE;
    IF FOUND THEN
      v_open_balance := GREATEST(COALESCE(v_inv.total, 0) - COALESCE(v_inv.amount_paid, 0), 0);
    END IF;
  END IF;

  v_to_ar := LEAST(v_cn.total, v_open_balance);
  v_to_credit := v_cn.total - v_to_ar;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', v_rev, 'debit', v_cn.subtotal, 'credit', 0,
      'description', 'Credit Note ' || v_cn.credit_note_number || ' — revenue reversal')
  );
  IF COALESCE(v_cn.tax_amount, 0) > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_tax, 'debit', v_cn.tax_amount, 'credit', 0,
        'description', 'Credit Note ' || v_cn.credit_note_number || ' — tax reversal'));
  END IF;
  IF v_to_ar > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_ar, 'debit', 0, 'credit', v_to_ar,
        'description', 'Credit Note ' || v_cn.credit_note_number || ' — receivable reduction',
        'contact_id', v_cn.contact_id));
  END IF;
  IF v_to_credit > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_credit_liab, 'debit', 0, 'credit', v_to_credit,
        'description', 'Credit Note ' || v_cn.credit_note_number || ' — customer credit',
        'contact_id', v_cn.contact_id));
  END IF;

  v_je_id := public.post_journal_entry_atomic(
    _org_id := v_cn.organization_id,
    _business_id := v_cn.business_id,
    _entry_number := public.generate_next_je_number(v_cn.organization_id, v_cn.business_id),
    _entry_date := v_cn.issue_date,
    _reference := v_cn.credit_note_number,
    _description := 'Credit Note ' || v_cn.credit_note_number || ' issued',
    _source_type := 'credit_note',
    _source_id := _credit_note_id,
    _created_by := auth.uid(),
    _is_closing := false,
    _is_adjusting := false,
    _lines := v_lines,
    _currency := v_cn.currency,
    _exchange_rate := NULL,
    _source_subtype := NULL,
    _branch_id := v_cn.branch_id
  );

  -- Receivable leg settles the invoice directly.
  IF v_to_ar > 0 AND v_cn.invoice_id IS NOT NULL THEN
    UPDATE public.invoices
       SET amount_paid = COALESCE(amount_paid, 0) + v_to_ar,
           status = CASE
             WHEN COALESCE(amount_paid, 0) + v_to_ar >= COALESCE(total, 0) THEN 'paid'::invoice_status
             ELSE 'partial'::invoice_status END
     WHERE id = v_cn.invoice_id;
  END IF;

  -- Credit leg creates real, consumable customer credit.
  IF v_to_credit > 0 THEN
    v_balance_id := public.customer_credit_balance_id(
      v_cn.organization_id, v_cn.business_id, v_cn.contact_id, v_cn.currency);
    INSERT INTO public.customer_credit_movements (
      organization_id, business_id, branch_id, contact_id, balance_id,
      kind, amount, currency, credit_note_id, journal_entry_id, created_by, notes
    ) VALUES (
      v_cn.organization_id, v_cn.business_id, v_cn.branch_id, v_cn.contact_id, v_balance_id,
      'issue', v_to_credit, v_cn.currency, _credit_note_id, v_je_id, auth.uid(),
      'Credit note issued'
    );
  END IF;

  UPDATE public.credit_notes
     SET status = 'issued'::credit_note_status,
         amount_applied = COALESCE(amount_applied, 0) + v_to_ar,
         updated_at = now()
   WHERE id = _credit_note_id;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_je_id,
    'applied_to_invoice', v_to_ar,
    'customer_credit_created', v_to_credit
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.apply_credit_to_invoice_atomic(
  _org_id uuid,
  _business_id uuid,
  _credit_note_id uuid,
  _invoice_id uuid,
  _amount numeric,
  _applied_by uuid,
  _notes text,
  _branch_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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
    _lines := jsonb_build_array(
      jsonb_build_object('account_id', v_credit_liab, 'debit', _amount, 'credit', 0,
        'description', 'Customer credit consumed: ' || v_cn.credit_note_number,
        'contact_id', v_cn.contact_id),
      jsonb_build_object('account_id', v_ar, 'debit', 0, 'credit', _amount,
        'description', 'Receivable settled by credit: ' || v_inv.invoice_number,
        'contact_id', v_cn.contact_id)
    ),
    _currency := v_cn.currency,
    _exchange_rate := NULL,
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
    'invoice_amount_paid', v_new_inv_paid
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.refund_customer_atomic(
  _source text,
  _source_id uuid,
  _bank_account_id uuid,
  _amount numeric,
  _refund_date date,
  _reason_code public.payment_reversal_reason,
  _reason_text text,
  _payment_method text,
  _reference text,
  _client_request_id text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_credit  public.credit_notes%ROWTYPE;
  v_org_id uuid; v_business_id uuid; v_contact_id uuid; v_currency text;
  v_drain_account uuid;
  v_je_id uuid; v_refund_id uuid; v_event_id uuid;
  v_post_date date;
  v_balance_id uuid; v_available numeric;
  v_branch uuid;
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

  IF _source = 'credit_note' THEN
    v_currency := NULLIF(v_credit.currency, '');
  END IF;
  IF v_currency IS NULL THEN
    SELECT COALESCE(NULLIF(base_currency, ''), 'KES') INTO v_currency
    FROM public.businesses WHERE id = v_business_id;
  END IF;
  v_currency := COALESCE(v_currency, 'KES');

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
    _lines := jsonb_build_array(
      jsonb_build_object('account_id', v_drain_account, 'debit', _amount, 'credit', 0,
        'description', 'Customer refund — ' || _source, 'contact_id', v_contact_id),
      jsonb_build_object('account_id', _bank_account_id, 'debit', 0, 'credit', _amount,
        'description', 'Customer refund paid out', 'contact_id', v_contact_id)
    ),
    _currency := v_currency,
    _exchange_rate := NULL,
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
END;
$fn$;