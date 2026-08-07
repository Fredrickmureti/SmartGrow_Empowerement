-- ADR 0132 — Vendor (AP) compensation parity with ADR 0131.

-- 1) Account role + per-business provisioning ---------------------------------
INSERT INTO public.system_account_roles
  (role_key, label, description, category, required_account_type, is_mandatory, sort_order)
VALUES ('vendor_credit', 'Vendor Credits',
        'Unapplied vendor credit created by vendor credit notes; kept separate from Accounts Payable.',
        'core', 'asset', false, 206)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO public.account_role_eligibility (role_key, account_type, detail_type, priority)
VALUES ('vendor_credit', 'asset', 'other_current_asset', 1)
ON CONFLICT DO NOTHING;

DO $prov$
DECLARE r record;
BEGIN
  FOR r IN SELECT b.organization_id, b.id AS business_id FROM public.businesses b
            WHERE EXISTS (SELECT 1 FROM public.accounts a WHERE a.business_id = b.id)
  LOOP
    PERFORM public.upsert_system_account(
      r.organization_id, r.business_id, 'vendor_credit', 'asset', 'other_current_asset',
      '1215', 'Vendor Credits',
      'Unapplied vendor credit created by vendor credit notes.', NULL, false);
  END LOOP;
END $prov$;

INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id, source)
SELECT a.organization_id, a.business_id, 'vendor_credit', a.id, 'manual'
FROM public.accounts a
WHERE a.system_role = 'vendor_credit'
  AND NOT EXISTS (
    SELECT 1 FROM public.default_account_settings d
     WHERE d.business_id = a.business_id AND d.setting_key = 'vendor_credit'
  );

CREATE OR REPLACE FUNCTION public.vendor_credit_account(_business_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  SELECT account_id INTO v_id
  FROM public.default_account_settings
  WHERE business_id = _business_id AND setting_key = 'vendor_credit';
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.accounts
     WHERE business_id = _business_id AND system_role = 'vendor_credit' AND COALESCE(is_active, true)
     LIMIT 1;
  END IF;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'default account "vendor_credit" is not configured for this company'
      USING HINT = 'Settings → Default Accounts';
  END IF;
  RETURN v_id;
END $$;

-- 2) Vendor credit ledger ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vendor_credit_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  currency text NOT NULL DEFAULT 'KES',
  credited_total numeric NOT NULL DEFAULT 0,
  applied_total numeric NOT NULL DEFAULT 0,
  refunded_total numeric NOT NULL DEFAULT 0,
  expired_total numeric NOT NULL DEFAULT 0,
  balance numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, vendor_id, currency)
);

CREATE TABLE IF NOT EXISTS public.vendor_credit_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  vendor_id uuid NOT NULL,
  balance_id uuid NOT NULL REFERENCES public.vendor_credit_balances(id),
  kind text NOT NULL CHECK (kind IN ('issue','apply','refund','expire')),
  amount numeric NOT NULL CHECK (amount > 0),
  currency text NOT NULL,
  vendor_credit_note_id uuid,
  bill_id uuid,
  refund_id uuid,
  journal_entry_id uuid,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vcm_balance ON public.vendor_credit_movements(balance_id);
CREATE INDEX IF NOT EXISTS idx_vcm_vcn ON public.vendor_credit_movements(vendor_credit_note_id);

CREATE TABLE IF NOT EXISTS public.vendor_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  vendor_id uuid NOT NULL,
  source_vendor_credit_note_id uuid,
  amount numeric NOT NULL CHECK (amount > 0),
  currency text NOT NULL,
  refund_date date NOT NULL,
  bank_account_id uuid NOT NULL,
  payment_method text,
  reference text,
  reason text,
  status text NOT NULL DEFAULT 'posted',
  journal_entry_id uuid,
  created_by uuid,
  client_request_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.vendor_credit_balances TO authenticated;
GRANT SELECT ON public.vendor_credit_movements TO authenticated;
GRANT SELECT ON public.vendor_refunds TO authenticated;
GRANT ALL ON public.vendor_credit_balances TO service_role;
GRANT ALL ON public.vendor_credit_movements TO service_role;
GRANT ALL ON public.vendor_refunds TO service_role;

ALTER TABLE public.vendor_credit_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_credit_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_refunds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read vendor credit balances" ON public.vendor_credit_balances;
CREATE POLICY "Members read vendor credit balances" ON public.vendor_credit_balances
  FOR SELECT TO authenticated USING (public.user_can_access_business(auth.uid(), business_id));
DROP POLICY IF EXISTS "Members read vendor credit movements" ON public.vendor_credit_movements;
CREATE POLICY "Members read vendor credit movements" ON public.vendor_credit_movements
  FOR SELECT TO authenticated USING (public.user_can_access_business(auth.uid(), business_id));
DROP POLICY IF EXISTS "Members read vendor refunds" ON public.vendor_refunds;
CREATE POLICY "Members read vendor refunds" ON public.vendor_refunds
  FOR SELECT TO authenticated USING (public.user_can_access_business(auth.uid(), business_id));

-- Append-only + projection, mirroring the customer credit ledger.
CREATE OR REPLACE FUNCTION public._vcm_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'vendor_credit_movements is append-only';
END $$;

CREATE OR REPLACE FUNCTION public._vcm_project_balance()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE public.vendor_credit_balances b
     SET credited_total = b.credited_total + CASE WHEN NEW.kind = 'issue'  THEN NEW.amount ELSE 0 END,
         applied_total  = b.applied_total  + CASE WHEN NEW.kind = 'apply'  THEN NEW.amount ELSE 0 END,
         refunded_total = b.refunded_total + CASE WHEN NEW.kind = 'refund' THEN NEW.amount ELSE 0 END,
         expired_total  = b.expired_total  + CASE WHEN NEW.kind = 'expire' THEN NEW.amount ELSE 0 END,
         balance        = b.balance + CASE WHEN NEW.kind = 'issue' THEN NEW.amount ELSE -NEW.amount END,
         updated_at     = now()
   WHERE b.id = NEW.balance_id;

  IF (SELECT balance FROM public.vendor_credit_balances WHERE id = NEW.balance_id) < -0.01 THEN
    RAISE EXCEPTION 'vendor credit balance cannot go negative (movement % of %)', NEW.kind, NEW.amount;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_vcm_append_only ON public.vendor_credit_movements;
CREATE TRIGGER trg_vcm_append_only BEFORE UPDATE OR DELETE ON public.vendor_credit_movements
  FOR EACH ROW EXECUTE FUNCTION public._vcm_append_only();
DROP TRIGGER IF EXISTS trg_vcm_project ON public.vendor_credit_movements;
CREATE TRIGGER trg_vcm_project AFTER INSERT ON public.vendor_credit_movements
  FOR EACH ROW EXECUTE FUNCTION public._vcm_project_balance();

CREATE OR REPLACE FUNCTION public.vendor_credit_balance_id(
  _org_id uuid, _business_id uuid, _vendor_id uuid, _currency text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.vendor_credit_balances (organization_id, business_id, vendor_id, currency)
  VALUES (_org_id, _business_id, _vendor_id, COALESCE(NULLIF(_currency, ''), 'KES'))
  ON CONFLICT (business_id, vendor_id, currency) DO UPDATE SET updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- 3) Retire the legacy vendor writers (no fallbacks) -------------------------
DROP FUNCTION IF EXISTS public.confirm_vendor_credit_note_atomic(uuid, uuid);
DROP FUNCTION IF EXISTS public.apply_vendor_credit_note_atomic(uuid, uuid[], uuid);

-- 4) Canonical writer family -------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_vendor_credit_note_atomic(
  _org_id uuid, _business_id uuid, _branch_id uuid, _vendor_id uuid, _bill_id uuid,
  _credit_date date, _notes text, _items jsonb, _issue boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_number text; v_id uuid;
  v_subtotal numeric := 0; v_tax numeric := 0;
  v_currency text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '42501'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), _business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', _business_id USING ERRCODE = '42501';
  END IF;
  IF _items IS NULL OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'a vendor credit note needs at least one line';
  END IF;

  SELECT COALESCE(SUM((i->>'line_total')::numeric), 0),
         COALESCE(SUM(COALESCE((i->>'tax_amount')::numeric, 0)), 0)
    INTO v_subtotal, v_tax
    FROM jsonb_array_elements(_items) i;

  SELECT COALESCE(NULLIF(b.currency, ''), (SELECT NULLIF(base_currency,'') FROM public.businesses WHERE id = _business_id), 'KES')
    INTO v_currency FROM public.bills b WHERE b.id = _bill_id;
  IF v_currency IS NULL THEN
    SELECT COALESCE(NULLIF(base_currency, ''), 'KES') INTO v_currency FROM public.businesses WHERE id = _business_id;
  END IF;

  v_number := public.get_next_vendor_credit_note_number(_org_id, _business_id);

  INSERT INTO public.vendor_credit_notes (
    organization_id, business_id, branch_id, credit_note_number, vendor_id, bill_id,
    status, credit_date, subtotal, tax_amount, total, amount_applied, currency, notes, created_by
  ) VALUES (
    _org_id, _business_id, _branch_id, v_number, _vendor_id, _bill_id,
    'draft', COALESCE(_credit_date, CURRENT_DATE), v_subtotal, v_tax, v_subtotal + v_tax, 0,
    v_currency, _notes, auth.uid()
  ) RETURNING id INTO v_id;

  INSERT INTO public.vendor_credit_note_items (
    credit_note_id, product_id, account_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, sort_order)
  SELECT v_id,
         NULLIF(i->>'product_id','')::uuid,
         NULLIF(i->>'account_id','')::uuid,
         i->>'description',
         COALESCE((i->>'quantity')::numeric, 1),
         COALESCE((i->>'unit_price')::numeric, 0),
         COALESCE((i->>'tax_rate')::numeric, 0),
         COALESCE((i->>'tax_amount')::numeric, 0),
         COALESCE((i->>'line_total')::numeric, 0),
         COALESCE((i->>'sort_order')::int, ord::int)
    FROM jsonb_array_elements(_items) WITH ORDINALITY AS t(i, ord);

  IF _issue THEN
    PERFORM public.issue_vendor_credit_note_atomic(v_id);
  END IF;

  RETURN jsonb_build_object('id', v_id, 'credit_note_number', v_number, 'total', v_subtotal + v_tax);
END $$;

CREATE OR REPLACE FUNCTION public.issue_vendor_credit_note_atomic(_vcn_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_vcn public.vendor_credit_notes%ROWTYPE;
  v_bill public.bills%ROWTYPE;
  v_open numeric := 0; v_to_ap numeric := 0; v_to_credit numeric := 0;
  v_ap uuid; v_exp uuid; v_tax uuid; v_credit_asset uuid;
  v_lines jsonb := '[]'::jsonb; v_je_id uuid; v_balance_id uuid;
  v_row record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_vcn FROM public.vendor_credit_notes WHERE id = _vcn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vendor credit note % not found', _vcn_id; END IF;
  IF v_vcn.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft vendor credit notes can be issued (current: %)', v_vcn.status;
  END IF;
  IF v_vcn.business_id IS NULL OR NOT public.user_can_access_business(auth.uid(), v_vcn.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_vcn.business_id USING ERRCODE = '42501';
  END IF;
  IF COALESCE(v_vcn.total, 0) <= 0 THEN
    RAISE EXCEPTION 'Vendor credit note % has a non-positive total', v_vcn.credit_note_number;
  END IF;
  IF NOT public.is_period_open(v_vcn.business_id, v_vcn.credit_date) THEN
    RAISE EXCEPTION 'accounting period is closed for %', v_vcn.credit_date;
  END IF;

  PERFORM public.assert_no_existing_source_posting(v_vcn.organization_id, 'vendor_credit_note', _vcn_id, NULL);

  v_ap  := public.compensation_account(v_vcn.business_id, 'accounts_payable');
  v_exp := public.compensation_account(v_vcn.business_id, 'operating_expenses');
  v_credit_asset := public.vendor_credit_account(v_vcn.business_id);
  IF COALESCE(v_vcn.tax_amount, 0) > 0 THEN
    v_tax := public.compensation_account(v_vcn.business_id, 'input_tax');
  END IF;

  -- Expense / inventory reversal, per line account where the line names one.
  FOR v_row IN
    SELECT COALESCE(i.account_id, v_exp) AS account_id, SUM(COALESCE(i.line_total, 0)) AS amt
      FROM public.vendor_credit_note_items i
     WHERE i.credit_note_id = _vcn_id
     GROUP BY COALESCE(i.account_id, v_exp)
  LOOP
    IF v_row.amt > 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_row.account_id, 'debit', 0, 'credit', v_row.amt,
        'description', 'VCN ' || v_vcn.credit_note_number || ' — cost reversal'));
    END IF;
  END LOOP;

  IF COALESCE(v_vcn.tax_amount, 0) > 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_tax, 'debit', 0, 'credit', v_vcn.tax_amount,
      'description', 'VCN ' || v_vcn.credit_note_number || ' — input tax reversal'));
  END IF;

  -- Reduce the payable only up to the linked bill's still-open balance; the
  -- remainder is vendor credit (an asset), never a negative payable.
  IF v_vcn.bill_id IS NOT NULL THEN
    SELECT * INTO v_bill FROM public.bills WHERE id = v_vcn.bill_id FOR UPDATE;
    IF FOUND THEN
      v_open := GREATEST(COALESCE(v_bill.total, 0) - COALESCE(v_bill.amount_paid, 0), 0);
    END IF;
  END IF;
  v_to_ap := LEAST(v_vcn.total, v_open);
  v_to_credit := v_vcn.total - v_to_ap;

  IF v_to_ap > 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_ap, 'debit', v_to_ap, 'credit', 0,
      'description', 'VCN ' || v_vcn.credit_note_number || ' — payable reduction',
      'contact_id', v_vcn.vendor_id));
  END IF;
  IF v_to_credit > 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_credit_asset, 'debit', v_to_credit, 'credit', 0,
      'description', 'VCN ' || v_vcn.credit_note_number || ' — vendor credit',
      'contact_id', v_vcn.vendor_id));
  END IF;

  v_je_id := public.post_journal_entry_atomic(
    _org_id := v_vcn.organization_id,
    _business_id := v_vcn.business_id,
    _entry_number := public.generate_next_je_number(v_vcn.organization_id, v_vcn.business_id),
    _entry_date := v_vcn.credit_date,
    _reference := v_vcn.credit_note_number,
    _description := 'Vendor credit note ' || v_vcn.credit_note_number || ' issued',
    _source_type := 'vendor_credit_note',
    _source_id := _vcn_id,
    _created_by := auth.uid(),
    _is_closing := false,
    _is_adjusting := false,
    _lines := v_lines,
    _currency := v_vcn.currency,
    _exchange_rate := NULL,
    _source_subtype := NULL,
    _branch_id := v_vcn.branch_id
  );

  IF v_to_ap > 0 AND v_vcn.bill_id IS NOT NULL THEN
    UPDATE public.bills
       SET amount_paid = COALESCE(amount_paid, 0) + v_to_ap,
           status = CASE WHEN COALESCE(amount_paid, 0) + v_to_ap >= COALESCE(total, 0)
                         THEN 'paid' ELSE 'partial' END,
           updated_at = now()
     WHERE id = v_vcn.bill_id;

    INSERT INTO public.vendor_credit_note_applications
      (credit_note_id, bill_id, amount, applied_at, applied_by, organization_id, business_id, notes)
    VALUES (_vcn_id, v_vcn.bill_id, v_to_ap, now(), auth.uid(),
            v_vcn.organization_id, v_vcn.business_id, 'Applied on issue');
  END IF;

  IF v_to_credit > 0 THEN
    v_balance_id := public.vendor_credit_balance_id(
      v_vcn.organization_id, v_vcn.business_id, v_vcn.vendor_id, v_vcn.currency);
    INSERT INTO public.vendor_credit_movements (
      organization_id, business_id, branch_id, vendor_id, balance_id,
      kind, amount, currency, vendor_credit_note_id, journal_entry_id, created_by, notes
    ) VALUES (
      v_vcn.organization_id, v_vcn.business_id, v_vcn.branch_id, v_vcn.vendor_id, v_balance_id,
      'issue', v_to_credit, v_vcn.currency, _vcn_id, v_je_id, auth.uid(), 'Vendor credit note issued'
    );
  END IF;

  UPDATE public.vendor_credit_notes
     SET status = CASE WHEN v_to_ap >= v_vcn.total THEN 'applied' ELSE 'confirmed' END,
         amount_applied = COALESCE(amount_applied, 0) + v_to_ap,
         journal_entry_id = v_je_id,
         updated_at = now()
   WHERE id = _vcn_id;

  RETURN jsonb_build_object('success', true, 'journal_entry_id', v_je_id,
    'applied_to_bill', v_to_ap, 'vendor_credit_created', v_to_credit);
END $$;

CREATE OR REPLACE FUNCTION public.apply_vendor_credit_to_bill_atomic(
  _org_id uuid, _business_id uuid, _vendor_credit_note_id uuid, _bill_id uuid,
  _amount numeric, _applied_by uuid DEFAULT NULL, _notes text DEFAULT NULL,
  _branch_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_vcn public.vendor_credit_notes%ROWTYPE;
  v_bill public.bills%ROWTYPE;
  v_available numeric; v_bill_balance numeric;
  v_balance_id uuid; v_je_id uuid; v_branch uuid;
  v_ap uuid; v_credit_asset uuid; v_actor uuid := COALESCE(_applied_by, auth.uid());
  v_new_paid numeric;
BEGIN
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Application amount must be positive'; END IF;

  SELECT * INTO v_vcn FROM public.vendor_credit_notes
   WHERE id = _vendor_credit_note_id AND organization_id = _org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vendor credit note not found'; END IF;
  IF v_vcn.business_id IS DISTINCT FROM _business_id THEN
    RAISE EXCEPTION 'Vendor credit note business mismatch';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), _business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', _business_id USING ERRCODE = '42501';
  END IF;
  IF v_vcn.status NOT IN ('confirmed','applied') THEN
    RAISE EXCEPTION 'Only an issued vendor credit note can be applied (current: %)', v_vcn.status;
  END IF;
  -- Row-level SoD: whoever created the credit note cannot also spend it.
  IF v_vcn.created_by IS NOT NULL AND v_vcn.created_by = v_actor THEN
    RAISE EXCEPTION 'SoD violation: the user who raised this credit note cannot apply it';
  END IF;

  SELECT * INTO v_bill FROM public.bills WHERE id = _bill_id AND organization_id = _org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  IF v_bill.business_id IS DISTINCT FROM _business_id THEN RAISE EXCEPTION 'Bill business mismatch'; END IF;
  IF v_bill.vendor_id IS DISTINCT FROM v_vcn.vendor_id THEN
    RAISE EXCEPTION 'Vendor credit may only be applied to the same vendor''s bills';
  END IF;

  v_branch := COALESCE(v_bill.branch_id, v_vcn.branch_id, _branch_id);

  v_balance_id := public.vendor_credit_balance_id(_org_id, _business_id, v_vcn.vendor_id, v_vcn.currency);
  SELECT balance INTO v_available FROM public.vendor_credit_balances WHERE id = v_balance_id;
  IF _amount > COALESCE(v_available, 0) + 0.01 THEN
    RAISE EXCEPTION 'Amount (%) exceeds available vendor credit (%)', _amount, COALESCE(v_available, 0);
  END IF;

  v_bill_balance := COALESCE(v_bill.total, 0) - COALESCE(v_bill.amount_paid, 0);
  IF _amount > v_bill_balance + 0.01 THEN
    RAISE EXCEPTION 'Amount (%) exceeds bill balance (%)', _amount, v_bill_balance;
  END IF;

  IF NOT public.is_period_open(_business_id, CURRENT_DATE) THEN
    RAISE EXCEPTION 'accounting period is closed for %', CURRENT_DATE;
  END IF;

  v_ap := public.compensation_account(_business_id, 'accounts_payable');
  v_credit_asset := public.vendor_credit_account(_business_id);

  INSERT INTO public.vendor_credit_note_applications
    (credit_note_id, bill_id, amount, applied_at, applied_by, organization_id, business_id, notes)
  VALUES (_vendor_credit_note_id, _bill_id, _amount, now(), v_actor, _org_id, _business_id, _notes);

  v_je_id := public.post_journal_entry_atomic(
    _org_id := _org_id,
    _business_id := _business_id,
    _entry_number := public.generate_next_je_number(_org_id, _business_id),
    _entry_date := CURRENT_DATE,
    _reference := 'VCNA-' || v_vcn.credit_note_number || '-' || COALESCE(v_bill.bill_number, ''),
    _description := 'Apply vendor credit ' || v_vcn.credit_note_number || ' to bill ' || COALESCE(v_bill.bill_number, ''),
    _source_type := 'vendor_credit_application',
    _source_id := _vendor_credit_note_id,
    _created_by := v_actor,
    _is_closing := false,
    _is_adjusting := false,
    _lines := jsonb_build_array(
      jsonb_build_object('account_id', v_ap, 'debit', _amount, 'credit', 0,
        'description', 'Payable settled by vendor credit ' || v_vcn.credit_note_number,
        'contact_id', v_vcn.vendor_id),
      jsonb_build_object('account_id', v_credit_asset, 'debit', 0, 'credit', _amount,
        'description', 'Vendor credit consumed: ' || v_vcn.credit_note_number,
        'contact_id', v_vcn.vendor_id)
    ),
    _currency := v_vcn.currency,
    _exchange_rate := NULL,
    _source_subtype := NULL,
    _branch_id := v_branch
  );

  INSERT INTO public.vendor_credit_movements (
    organization_id, business_id, branch_id, vendor_id, balance_id,
    kind, amount, currency, vendor_credit_note_id, bill_id, journal_entry_id, created_by, notes
  ) VALUES (
    _org_id, _business_id, v_branch, v_vcn.vendor_id, v_balance_id,
    'apply', _amount, v_vcn.currency, _vendor_credit_note_id, _bill_id, v_je_id, v_actor, _notes
  );

  v_new_paid := COALESCE(v_bill.amount_paid, 0) + _amount;
  UPDATE public.bills
     SET amount_paid = v_new_paid,
         status = CASE WHEN v_new_paid >= COALESCE(total, 0) THEN 'paid' ELSE 'partial' END,
         updated_at = now()
   WHERE id = _bill_id;

  UPDATE public.vendor_credit_notes
     SET amount_applied = COALESCE(amount_applied, 0) + _amount,
         status = CASE WHEN COALESCE(amount_applied, 0) + _amount >= total THEN 'applied' ELSE status END,
         updated_at = now()
   WHERE id = _vendor_credit_note_id;

  RETURN jsonb_build_object('success', true, 'journal_entry_id', v_je_id,
    'amount_applied', _amount, 'bill_amount_paid', v_new_paid);
END $$;

CREATE OR REPLACE FUNCTION public.refund_from_vendor_atomic(
  _vendor_credit_note_id uuid, _bank_account_id uuid, _amount numeric,
  _refund_date date DEFAULT NULL, _reason_text text DEFAULT NULL,
  _payment_method text DEFAULT NULL, _reference text DEFAULT NULL,
  _client_request_id text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_vcn public.vendor_credit_notes%ROWTYPE;
  v_post_date date; v_balance_id uuid; v_available numeric;
  v_credit_asset uuid; v_je_id uuid; v_refund_id uuid;
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
    _amount, v_vcn.currency, v_post_date, _bank_account_id, _payment_method, _reference, _reason_text,
    'posted', auth.uid(), _client_request_id
  ) RETURNING id INTO v_refund_id;

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
    _lines := jsonb_build_array(
      jsonb_build_object('account_id', _bank_account_id, 'debit', _amount, 'credit', 0,
        'description', 'Vendor refund received', 'contact_id', v_vcn.vendor_id),
      jsonb_build_object('account_id', v_credit_asset, 'debit', 0, 'credit', _amount,
        'description', 'Vendor credit refunded: ' || v_vcn.credit_note_number,
        'contact_id', v_vcn.vendor_id)
    ),
    _currency := v_vcn.currency,
    _exchange_rate := NULL,
    _source_subtype := NULL,
    _branch_id := v_vcn.branch_id
  );

  UPDATE public.vendor_refunds SET journal_entry_id = v_je_id, updated_at = now() WHERE id = v_refund_id;

  INSERT INTO public.vendor_credit_movements (
    organization_id, business_id, branch_id, vendor_id, balance_id,
    kind, amount, currency, vendor_credit_note_id, refund_id, journal_entry_id, created_by, notes
  ) VALUES (
    v_vcn.organization_id, v_vcn.business_id, v_vcn.branch_id, v_vcn.vendor_id, v_balance_id,
    'refund', _amount, v_vcn.currency, _vendor_credit_note_id, v_refund_id, v_je_id, auth.uid(), _reason_text
  );

  RETURN v_refund_id;
END $$;

-- 5) Tie-out + drift ---------------------------------------------------------
CREATE OR REPLACE VIEW public.vendor_credit_tieout
WITH (security_invoker = true) AS
WITH vc_accounts AS (
  SELECT DISTINCT b.organization_id, b.id AS business_id, a.id AS account_id
    FROM public.businesses b
    JOIN public.accounts a ON a.business_id = b.id AND a.system_role = 'vendor_credit'
), gl AS (
  SELECT ca.organization_id, ca.business_id, ca.account_id,
         COALESCE(NULLIF(jel.original_currency, ''), bz.base_currency) AS currency,
         SUM(COALESCE(COALESCE(jel.original_debit, jel.debit), 0)
             - COALESCE(COALESCE(jel.original_credit, jel.credit), 0)) AS gl_balance
    FROM vc_accounts ca
    JOIN public.businesses bz ON bz.id = ca.business_id
    JOIN public.journal_entry_lines jel ON jel.account_id = ca.account_id
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
   WHERE je.status = 'posted'
     AND COALESCE(jel.business_id, ca.business_id) = ca.business_id
   GROUP BY ca.organization_id, ca.business_id, ca.account_id,
            COALESCE(NULLIF(jel.original_currency, ''), bz.base_currency)
), sub AS (
  SELECT vcb.organization_id, vcb.business_id, ca.account_id, vcb.currency,
         SUM(vcb.balance) AS sub_balance
    FROM public.vendor_credit_balances vcb
    JOIN vc_accounts ca ON ca.business_id = vcb.business_id
   GROUP BY vcb.organization_id, vcb.business_id, ca.account_id, vcb.currency
)
SELECT COALESCE(gl.organization_id, sub.organization_id) AS organization_id,
       COALESCE(gl.business_id, sub.business_id) AS business_id,
       COALESCE(gl.account_id, sub.account_id) AS account_id,
       a.code AS account_code, a.name AS account_name, a.system_role,
       COALESCE(gl.currency, sub.currency) AS currency,
       COALESCE(gl.gl_balance, 0) AS gl_balance,
       COALESCE(sub.sub_balance, 0) AS subledger_balance,
       COALESCE(gl.gl_balance, 0) - COALESCE(sub.sub_balance, 0) AS drift
  FROM gl
  FULL JOIN sub ON sub.account_id = gl.account_id AND sub.currency = gl.currency
  LEFT JOIN public.accounts a ON a.id = COALESCE(gl.account_id, sub.account_id);

GRANT SELECT ON public.vendor_credit_tieout TO authenticated;

CREATE OR REPLACE FUNCTION public.snapshot_control_account_drift()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count integer;
  v_cc_count integer;
  v_vc_count integer;
BEGIN
  INSERT INTO public.control_account_drift_log
    (organization_id, account_id, account_code, account_name, system_role,
     gl_balance, subledger_balance, drift)
  SELECT organization_id, account_id, account_code, account_name, system_role,
         gl_balance, subledger_balance, drift
  FROM public.control_account_tieout
  WHERE abs(drift) > 0.005;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.control_account_drift_log
    (organization_id, account_id, account_code, account_name, system_role,
     gl_balance, subledger_balance, drift)
  SELECT organization_id, account_id, account_code,
         account_name || ' (' || currency || ')',
         COALESCE(system_role, 'customer_credit'),
         gl_balance, subledger_balance, drift
  FROM public.customer_credit_tieout
  WHERE abs(drift) > 0.005;
  GET DIAGNOSTICS v_cc_count = ROW_COUNT;

  INSERT INTO public.control_account_drift_log
    (organization_id, account_id, account_code, account_name, system_role,
     gl_balance, subledger_balance, drift)
  SELECT organization_id, account_id, account_code,
         account_name || ' (' || currency || ')',
         COALESCE(system_role, 'vendor_credit'),
         gl_balance, subledger_balance, drift
  FROM public.vendor_credit_tieout
  WHERE abs(drift) > 0.005;
  GET DIAGNOSTICS v_vc_count = ROW_COUNT;

  RETURN v_count + v_cc_count + v_vc_count;
END $$;