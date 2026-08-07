-- =====================================================================
-- ADR 0131 — Commercial compensation architecture
-- Phase 3: customer credit as a real, GL-anchored balance
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.customer_credit_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  currency text NOT NULL DEFAULT 'KES',
  credited_total numeric NOT NULL DEFAULT 0,
  applied_total numeric NOT NULL DEFAULT 0,
  refunded_total numeric NOT NULL DEFAULT 0,
  expired_total numeric NOT NULL DEFAULT 0,
  balance numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, contact_id, currency)
);

GRANT SELECT ON public.customer_credit_balances TO authenticated;
GRANT ALL ON public.customer_credit_balances TO service_role;
ALTER TABLE public.customer_credit_balances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read customer credit balances"
ON public.customer_credit_balances FOR SELECT TO authenticated
USING (public.user_can_access_business(auth.uid(), business_id));

CREATE TABLE IF NOT EXISTS public.customer_credit_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  contact_id uuid NOT NULL,
  balance_id uuid NOT NULL REFERENCES public.customer_credit_balances(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('issue','apply','refund','expire')),
  amount numeric NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'KES',
  credit_note_id uuid REFERENCES public.credit_notes(id) ON DELETE RESTRICT,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE RESTRICT,
  refund_id uuid REFERENCES public.customer_refunds(id) ON DELETE RESTRICT,
  journal_entry_id uuid,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.customer_credit_movements TO authenticated;
GRANT ALL ON public.customer_credit_movements TO service_role;
ALTER TABLE public.customer_credit_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read customer credit movements"
ON public.customer_credit_movements FOR SELECT TO authenticated
USING (public.user_can_access_business(auth.uid(), business_id));

CREATE INDEX IF NOT EXISTS idx_ccm_balance ON public.customer_credit_movements(balance_id);
CREATE INDEX IF NOT EXISTS idx_ccm_contact ON public.customer_credit_movements(business_id, contact_id);

-- Append-only: movements are never edited or deleted.
CREATE OR REPLACE FUNCTION public._ccm_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'customer_credit_movements is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_ccm_append_only ON public.customer_credit_movements;
CREATE TRIGGER trg_ccm_append_only
BEFORE UPDATE OR DELETE ON public.customer_credit_movements
FOR EACH ROW EXECUTE FUNCTION public._ccm_append_only();

-- Balance is a projection of the movements, maintained by trigger.
CREATE OR REPLACE FUNCTION public._ccm_project_balance()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE public.customer_credit_balances b
     SET credited_total = b.credited_total + CASE WHEN NEW.kind = 'issue'  THEN NEW.amount ELSE 0 END,
         applied_total  = b.applied_total  + CASE WHEN NEW.kind = 'apply'  THEN NEW.amount ELSE 0 END,
         refunded_total = b.refunded_total + CASE WHEN NEW.kind = 'refund' THEN NEW.amount ELSE 0 END,
         expired_total  = b.expired_total  + CASE WHEN NEW.kind = 'expire' THEN NEW.amount ELSE 0 END,
         balance        = b.balance + CASE WHEN NEW.kind = 'issue' THEN NEW.amount ELSE -NEW.amount END,
         updated_at     = now()
   WHERE b.id = NEW.balance_id;

  IF (SELECT balance FROM public.customer_credit_balances WHERE id = NEW.balance_id) < -0.01 THEN
    RAISE EXCEPTION 'customer credit balance cannot go negative (movement % of %)', NEW.kind, NEW.amount;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ccm_project_balance ON public.customer_credit_movements;
CREATE TRIGGER trg_ccm_project_balance
AFTER INSERT ON public.customer_credit_movements
FOR EACH ROW EXECUTE FUNCTION public._ccm_project_balance();

-- Resolve (or create) the credit balance row for a customer.
CREATE OR REPLACE FUNCTION public.customer_credit_balance_id(_org_id uuid, _business_id uuid, _contact_id uuid, _currency text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.customer_credit_balances (organization_id, business_id, contact_id, currency)
  VALUES (_org_id, _business_id, _contact_id, COALESCE(_currency, 'KES'))
  ON CONFLICT (business_id, contact_id, currency) DO UPDATE SET updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Single account resolver for compensation postings.
CREATE OR REPLACE FUNCTION public.compensation_account(_business_id uuid, _key text)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  SELECT account_id INTO v_id
  FROM public.default_account_settings
  WHERE business_id = _business_id AND setting_key = _key;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'default account "%" is not configured for this company', _key
      USING HINT = 'Settings → Default Accounts';
  END IF;
  RETURN v_id;
END;
$$;

-- =====================================================================
-- Phase 2: one server-side creation + issue writer
-- =====================================================================

CREATE OR REPLACE FUNCTION public.create_credit_note_atomic(
  _org_id uuid,
  _business_id uuid,
  _branch_id uuid,
  _contact_id uuid,
  _invoice_id uuid,
  _issue_date date,
  _reason text,
  _notes text,
  _items jsonb,
  _source_return_id uuid DEFAULT NULL,
  _issue boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cn_id uuid;
  v_number text;
  v_subtotal numeric := 0;
  v_tax numeric := 0;
  v_currency text;
  v_branch uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;
  IF _business_id IS NULL OR NOT public.user_can_access_business(auth.uid(), _business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', _business_id USING ERRCODE = '42501';
  END IF;
  IF _items IS NULL OR jsonb_typeof(_items) <> 'array' OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'A credit note requires at least one line';
  END IF;

  SELECT COALESCE(SUM((i->>'line_total')::numeric), 0),
         COALESCE(SUM((i->>'tax_amount')::numeric), 0)
    INTO v_subtotal, v_tax
  FROM jsonb_array_elements(_items) i;

  IF v_subtotal + v_tax <= 0 THEN
    RAISE EXCEPTION 'Credit note total must be positive';
  END IF;

  SELECT COALESCE(NULLIF(base_currency, ''), 'KES') INTO v_currency
  FROM public.businesses WHERE id = _business_id;

  v_branch := COALESCE((SELECT branch_id FROM public.invoices WHERE id = _invoice_id), _branch_id);
  v_number := public.get_next_credit_note_number(_org_id, _business_id, v_branch);

  INSERT INTO public.credit_notes (
    organization_id, business_id, branch_id, contact_id, invoice_id, original_invoice_id,
    credit_note_number, status, issue_date, subtotal, tax_amount, total,
    currency, reason, notes, source_return_id, created_by
  ) VALUES (
    _org_id, _business_id, v_branch, _contact_id, _invoice_id, _invoice_id,
    v_number, 'draft'::credit_note_status, COALESCE(_issue_date, CURRENT_DATE),
    v_subtotal, v_tax, v_subtotal + v_tax,
    COALESCE(v_currency, 'KES'), _reason, _notes, _source_return_id, auth.uid()
  ) RETURNING id INTO v_cn_id;

  INSERT INTO public.credit_note_items (
    credit_note_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, sort_order,
    packaging_id, display_uom_id, display_quantity, lot_number, serial_number
  )
  SELECT v_cn_id,
         NULLIF(i->>'product_id','')::uuid,
         i->>'description',
         COALESCE((i->>'quantity')::numeric, 0),
         COALESCE((i->>'unit_price')::numeric, 0),
         COALESCE((i->>'tax_rate')::numeric, 0),
         COALESCE((i->>'tax_amount')::numeric, 0),
         COALESCE((i->>'line_total')::numeric, 0),
         COALESCE((i->>'sort_order')::integer, (ord - 1)::integer),
         NULLIF(i->>'packaging_id','')::uuid,
         NULLIF(i->>'display_uom_id','')::uuid,
         NULLIF(i->>'display_quantity','')::numeric,
         NULLIF(i->>'lot_number',''),
         NULLIF(i->>'serial_number','')
  FROM jsonb_array_elements(_items) WITH ORDINALITY AS t(i, ord);

  IF _issue THEN
    PERFORM public.issue_credit_note_atomic(v_cn_id);
  END IF;

  RETURN jsonb_build_object('credit_note_id', v_cn_id, 'credit_note_number', v_number);
END;
$$;

-- Issue: builds the GL lines server-side and decides AR vs customer credit.
CREATE OR REPLACE FUNCTION public.issue_credit_note_atomic(_credit_note_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
  v_credit_liab := public.compensation_account(v_cn.business_id, 'customer_deposits');
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
$$;

-- Legacy client-fed writer becomes a thin shim: no browser-built GL lines.
CREATE OR REPLACE FUNCTION public.confirm_credit_note_atomic(p_cn_id uuid, p_user_id uuid, p_main_lines jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN public.issue_credit_note_atomic(p_cn_id);
END;
$$;

-- =====================================================================
-- Phase 3b: applying credit resolves accounts server-side and records a movement
-- =====================================================================

CREATE OR REPLACE FUNCTION public.apply_credit_to_invoice_atomic(
  _org_id uuid, _business_id uuid, _credit_note_id uuid, _invoice_id uuid,
  _amount numeric, _applied_by uuid, _notes text DEFAULT NULL::text,
  _customer_deposits_account_id uuid DEFAULT NULL::uuid,
  _receivable_account_id uuid DEFAULT NULL::uuid,
  _branch_id uuid DEFAULT NULL::uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  -- Availability comes from the credit balance, not from a derived column.
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

  v_credit_liab := public.compensation_account(_business_id, 'customer_deposits');
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
$$;

-- =====================================================================
-- Phase 4: one refund engine
-- =====================================================================

CREATE OR REPLACE FUNCTION public.refund_customer_atomic(
  _source text, _source_id uuid, _bank_account_id uuid, _amount numeric,
  _refund_date date, _reason_code payment_reversal_reason, _reason_text text,
  _payment_method text, _reference text, _client_request_id text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_credit  public.credit_notes%ROWTYPE;
  v_org_id uuid; v_business_id uuid; v_contact_id uuid; v_currency text;
  v_drain_account uuid;
  v_je_id uuid; v_refund_id uuid; v_event_id uuid;
  v_post_date date;
  v_balance_id uuid; v_available numeric;
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
    v_drain_account := public.compensation_account(v_business_id, 'customer_deposits');
  ELSE
    SELECT * INTO v_credit FROM public.credit_notes WHERE id = _source_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'source credit_note % not found', _source_id; END IF;
    IF v_credit.status NOT IN ('issued','applied','refunded') THEN
      RAISE EXCEPTION 'only an issued credit note can be refunded (current: %)', v_credit.status;
    END IF;
    v_org_id := v_credit.organization_id; v_business_id := v_credit.business_id;
    v_contact_id := v_credit.contact_id;
    -- A refund always drains customer credit (the liability), never AR.
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

  SELECT COALESCE(NULLIF(base_currency, ''), 'KES') INTO v_currency
  FROM public.businesses WHERE id = v_business_id;
  v_currency := COALESCE(v_currency, 'KES');

  IF _source = 'credit_note' THEN
    v_balance_id := public.customer_credit_balance_id(v_org_id, v_business_id, v_contact_id, v_credit.currency);
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
    v_org_id, v_business_id,
    CASE WHEN _source='credit_note' THEN v_credit.branch_id ELSE v_payment.branch_id END,
    v_contact_id,
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
    _branch_id := CASE WHEN _source='credit_note' THEN v_credit.branch_id ELSE v_payment.branch_id END
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
      v_org_id, v_business_id, v_credit.branch_id, v_contact_id, v_balance_id,
      'refund', _amount, v_credit.currency, _source_id, v_refund_id, v_je_id, auth.uid(), _reason_text
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
$$;

-- Retire the duplicate refund engine outright (ADR 0131: no fallback paths).
DROP FUNCTION IF EXISTS public.process_refund_atomic(uuid, uuid, numeric, text, uuid, text, jsonb);

GRANT EXECUTE ON FUNCTION public.create_credit_note_atomic(uuid, uuid, uuid, uuid, uuid, date, text, text, jsonb, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.issue_credit_note_atomic(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_credit_balance_id(uuid, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compensation_account(uuid, text) TO authenticated;