CREATE TABLE public.mf_collection_bankings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id),
  batch_id uuid NOT NULL UNIQUE REFERENCES public.mf_repayment_batches(id) ON DELETE RESTRICT,
  bank_account_id uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE RESTRICT,
  banked_on date NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  cash_amount numeric(18,2) NOT NULL DEFAULT 0,
  mobile_money_amount numeric(18,2) NOT NULL DEFAULT 0,
  reference text,
  notes text,
  journal_entry_id uuid REFERENCES public.journal_entries(id),
  bank_transaction_id uuid REFERENCES public.bank_transactions(id),
  banked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_mf_collection_bankings_business ON public.mf_collection_bankings(business_id, banked_on DESC);

GRANT SELECT ON public.mf_collection_bankings TO authenticated;
GRANT ALL ON public.mf_collection_bankings TO service_role;

ALTER TABLE public.mf_collection_bankings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view collection bankings in scope"
ON public.mf_collection_bankings FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.mf_repayment_batches b
    WHERE b.id = mf_collection_bankings.batch_id
      AND b.business_id = mf_collection_bankings.business_id
      AND public.mf_officer_in_scope(b.collected_by)
  )
);

CREATE OR REPLACE FUNCTION public.mf_collection_bankings_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'Collection bankings are append-only';
END;
$$;

CREATE TRIGGER mf_collection_bankings_no_mutate
BEFORE UPDATE OR DELETE ON public.mf_collection_bankings
FOR EACH ROW EXECUTE FUNCTION public.mf_collection_bankings_append_only();

CREATE OR REPLACE FUNCTION public.mf_bank_collection_batch(
  p_batch_id uuid,
  p_bank_account_id uuid,
  p_banked_on date DEFAULT NULL,
  p_reference text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  b            public.mf_repayment_batches%ROWTYPE;
  ba           public.bank_accounts%ROWTYPE;
  v_org        uuid;
  v_cash       numeric := 0;
  v_mm         numeric := 0;
  v_total      numeric := 0;
  v_lines      jsonb := '[]'::jsonb;
  v_desc       text;
  v_date       date;
  v_je         uuid;
  v_btxn       uuid;
  v_id         uuid;
  v_currency   text;
BEGIN
  SELECT * INTO b FROM public.mf_repayment_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Collection batch % not found', p_batch_id; END IF;
  IF b.status <> 'closed' THEN
    RAISE EXCEPTION 'Batch % must be closed before it can be banked', b.batch_number;
  END IF;
  IF EXISTS (SELECT 1 FROM public.mf_collection_bankings WHERE batch_id = p_batch_id) THEN
    RAISE EXCEPTION 'Batch % has already been banked', b.batch_number;
  END IF;

  SELECT * INTO ba FROM public.bank_accounts WHERE id = p_bank_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank account % not found', p_bank_account_id; END IF;
  IF ba.business_id IS DISTINCT FROM b.business_id THEN
    RAISE EXCEPTION 'Bank account does not belong to this institution';
  END IF;
  IF ba.account_id IS NULL THEN
    RAISE EXCEPTION 'Bank account % has no general ledger account configured', ba.name;
  END IF;

  SELECT
    COALESCE(SUM(CASE WHEN r.method = 'cash' THEN r.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN r.method = 'mobile_money' THEN r.amount ELSE 0 END), 0)
  INTO v_cash, v_mm
  FROM public.mf_repayments r
  WHERE r.batch_id = p_batch_id AND r.status = 'posted';

  v_total := v_cash + v_mm;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Batch % has no bankable cash or mobile-money receipts', b.batch_number;
  END IF;

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = b.business_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Institution % has no organization', b.business_id; END IF;

  v_date := COALESCE(p_banked_on, b.collected_on, CURRENT_DATE);
  v_desc := format('Banking of collection batch %s', b.batch_number);
  v_currency := COALESCE(ba.currency, 'KES');

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', ba.account_id, 'debit', v_total, 'credit', 0,
                       'description', v_desc));
  IF v_cash > 0 THEN
    v_lines := v_lines || jsonb_build_object(
      'account_id', public.mf_resolve_account(b.business_id, b.branch_id, 'cash'),
      'debit', 0, 'credit', v_cash, 'description', v_desc || ' - cash');
  END IF;
  IF v_mm > 0 THEN
    v_lines := v_lines || jsonb_build_object(
      'account_id', public.mf_resolve_account(b.business_id, b.branch_id, 'mobile_money'),
      'debit', 0, 'credit', v_mm, 'description', v_desc || ' - mobile money');
  END IF;

  v_id := gen_random_uuid();

  v_je := public.post_journal_entry_atomic(
    _org_id         => v_org,
    _business_id    => b.business_id,
    _entry_number   => NULL,
    _entry_date     => v_date,
    _reference      => COALESCE(p_reference, b.batch_number),
    _description    => v_desc,
    _source_type    => 'mf_collection_banking',
    _source_id      => v_id,
    _created_by     => auth.uid(),
    _is_closing     => false,
    _is_adjusting   => false,
    _lines          => v_lines,
    _currency       => v_currency,
    _exchange_rate  => NULL,
    _source_subtype => 'collection_banking',
    _branch_id      => b.branch_id);

  INSERT INTO public.bank_transactions (
    organization_id, business_id, branch_id, bank_account_id, transaction_date,
    posting_date, description, reference, amount, transaction_type,
    journal_entry_id, is_reconciled, lifecycle_status
  ) VALUES (
    v_org, b.business_id, b.branch_id, p_bank_account_id, v_date,
    v_date, v_desc, COALESCE(p_reference, b.batch_number), v_total, 'credit',
    v_je, false, 'active'
  ) RETURNING id INTO v_btxn;

  INSERT INTO public.mf_collection_bankings (
    id, business_id, branch_id, batch_id, bank_account_id, banked_on, amount,
    cash_amount, mobile_money_amount, reference, notes, journal_entry_id,
    bank_transaction_id, banked_by
  ) VALUES (
    v_id, b.business_id, b.branch_id, p_batch_id, p_bank_account_id, v_date, v_total,
    v_cash, v_mm, p_reference, p_notes, v_je, v_btxn, auth.uid()
  );

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.mf_bank_collection_batch(uuid, uuid, date, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.mf_bank_collection_batch(uuid, uuid, date, text, text) TO authenticated;