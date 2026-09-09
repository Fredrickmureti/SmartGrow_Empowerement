CREATE OR REPLACE FUNCTION public.mf_collect_group_admission_fees(
  p_group_id uuid,
  p_collected_on date DEFAULT NULL,
  p_method text DEFAULT 'cash',
  p_reference text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_lines jsonb DEFAULT NULL,
  p_client_request_id text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  g public.mf_groups%ROWTYPE;
  ln jsonb;
  v_org uuid;
  v_base text;
  v_rate numeric;
  v_on date := COALESCE(p_collected_on, CURRENT_DATE);
  v_method text := COALESCE(NULLIF(btrim(p_method), ''), 'cash');
  v_ref text := NULLIF(btrim(p_reference), '');
  v_key text := NULLIF(btrim(p_client_request_id), '');
  v_total numeric(18,2) := 0;
  v_currency text;
  v_collection uuid;
  v_number text;
  v_attempt integer := 0;
  v_client uuid;
  v_amount numeric(18,2);
  v_outstanding numeric(18,2);
  ch public.mf_client_charges%ROWTYPE;
  c public.mf_clients%ROWTYPE;
  v_receipt text;
  v_je uuid;
  v_desc text;
  v_lines jsonb := '[]'::jsonb;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_pay_ids uuid[] := ARRAY[]::uuid[];
  v_charge_id uuid;
  v_pay uuid;
BEGIN
  SELECT * INTO g FROM public.mf_groups WHERE id = p_group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That group does not exist.';
  END IF;
  IF NOT public.mf_can(g.business_id, g.branch_id, 'repayments', 'create') THEN
    RAISE EXCEPTION 'You do not have permission to perform this action.';
  END IF;

  IF v_key IS NOT NULL THEN
    SELECT id INTO v_collection FROM public.mf_fee_collections
     WHERE business_id = g.business_id AND client_request_id = v_key;
    IF v_collection IS NOT NULL THEN
      RETURN v_collection;
    END IF;
  END IF;

  IF v_ref IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.mf_fee_collections
       WHERE business_id = g.business_id AND reference = v_ref AND status = 'posted') THEN
    RAISE EXCEPTION 'A group collection with reference % has already been recorded.', v_ref;
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Select at least one member to collect from.';
  END IF;

  SELECT organization_id, base_currency INTO v_org, v_base
    FROM public.businesses WHERE id = g.business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Institution % has no organization', g.business_id;
  END IF;

  FOR ln IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_client := (ln->>'client_id')::uuid;
    v_amount := ROUND(COALESCE((ln->>'amount')::numeric, 0), 2);
    IF v_client IS NULL THEN
      RAISE EXCEPTION 'Every collection line needs a client.';
    END IF;
    IF v_client = ANY(v_seen) THEN
      RAISE EXCEPTION 'The same member appears twice in this collection.';
    END IF;
    v_seen := v_seen || v_client;
    IF v_amount <= 0 THEN
      RAISE EXCEPTION 'Enter an amount greater than zero for every selected member.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.mf_group_members m
                    WHERE m.group_id = g.id AND m.client_id = v_client AND m.is_active) THEN
      RAISE EXCEPTION 'One of the selected clients is not an active member of this group.';
    END IF;
    v_total := v_total + v_amount;
  END LOOP;

  SELECT COALESCE(NULLIF(btrim(pol.admission_fee_currency), ''), v_base)
    INTO v_currency
    FROM public.mf_client_fee_policy pol WHERE pol.business_id = g.business_id;
  v_currency := COALESCE(v_currency, v_base);
  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'This institution has no base currency configured.';
  END IF;
  IF v_currency = v_base THEN
    v_rate := 1;
  ELSE
    v_rate := public.require_exchange_rate(v_org, g.business_id, v_currency, v_on);
  END IF;

  LOOP
    v_attempt := v_attempt + 1;
    v_number := public.mf_next_fee_collection_number(g.business_id, v_on, v_attempt);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.mf_fee_collections
                           WHERE business_id = g.business_id AND collection_number = v_number);
    IF v_attempt >= 50 THEN
      RAISE EXCEPTION 'Could not allocate a collection number.';
    END IF;
  END LOOP;

  INSERT INTO public.mf_fee_collections (
    business_id, branch_id, group_id, kind, collection_number, collected_on,
    collected_by, total_amount, currency_code, method, reference, notes,
    status, client_request_id, created_by
  ) VALUES (
    g.business_id, g.branch_id, g.id, 'admission_fee', v_number, v_on,
    auth.uid(), v_total, v_currency, v_method, v_ref, p_notes,
    'posted', v_key, auth.uid()
  ) RETURNING id INTO v_collection;

  FOR ln IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_client := (ln->>'client_id')::uuid;
    v_amount := ROUND(COALESCE((ln->>'amount')::numeric, 0), 2);

    SELECT * INTO ch FROM public.mf_client_charges
     WHERE client_id = v_client AND kind = 'admission_fee' AND status <> 'reversed'
     FOR UPDATE;

    IF NOT FOUND THEN
      v_charge_id := public.mf_raise_client_admission_fee(v_client, v_on, 'Raised during group collection ' || v_number);
      SELECT * INTO ch FROM public.mf_client_charges WHERE id = v_charge_id FOR UPDATE;
    END IF;

    v_outstanding := ROUND(ch.amount - COALESCE(ch.paid_amount, 0), 2);
    IF v_outstanding <= 0 THEN
      RAISE EXCEPTION 'One of the selected members has no outstanding admission fee.';
    END IF;
    IF v_amount > v_outstanding THEN
      RAISE EXCEPTION 'An amount entered is more than that member''s outstanding fee of %.', v_outstanding;
    END IF;

    SELECT * INTO c FROM public.mf_clients WHERE id = v_client;

    v_attempt := 0;
    LOOP
      v_attempt := v_attempt + 1;
      v_receipt := public.mf_next_fee_receipt_number(g.business_id, v_on, v_attempt);
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.mf_client_charge_payments
                             WHERE business_id = g.business_id AND receipt_number = v_receipt)
        AND NOT EXISTS (SELECT 1 FROM public.mf_client_charges
                         WHERE business_id = g.business_id AND receipt_number = v_receipt);
      IF v_attempt >= 200 THEN
        RAISE EXCEPTION 'Could not allocate a receipt number.';
      END IF;
    END LOOP;

    INSERT INTO public.mf_client_charge_payments (
      business_id, branch_id, charge_id, client_id, collection_id, amount, paid_on,
      method, reference, receipt_number, status, notes, created_by
    ) VALUES (
      ch.business_id, ch.branch_id, ch.id, ch.client_id, v_collection, v_amount, v_on,
      v_method, v_ref, v_receipt, 'posted', p_notes, auth.uid()
    ) RETURNING id INTO v_pay;
    v_pay_ids := v_pay_ids || v_pay;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.mf_resolve_account(g.business_id, g.branch_id, 'fee_income'),
      'debit', 0, 'credit', v_amount,
      'description', format('Admission fee %s %s receipt %s', c.client_number, c.full_name, v_receipt)));
  END LOOP;

  v_desc := format('Group admission fee collection %s (%s)', v_number, g.name);

  v_lines := jsonb_build_array(jsonb_build_object(
      'account_id', public.mf_resolve_account(g.business_id, g.branch_id,
                      public.mf_method_mapping_key(v_method)),
      'debit', v_total, 'credit', 0, 'description', v_desc)) || v_lines;

  v_je := public.post_journal_entry_atomic(
    _org_id       => v_org,
    _business_id  => g.business_id,
    _entry_number => NULL,
    _entry_date   => v_on,
    _reference    => COALESCE(v_ref, v_number),
    _description  => v_desc,
    _source_type  => 'mf_fee_collection',
    _source_id    => v_collection,
    _created_by   => auth.uid(),
    _is_closing   => false,
    _is_adjusting => false,
    _lines        => v_lines,
    _currency     => v_currency,
    _exchange_rate => v_rate,
    _source_subtype => NULL,
    _branch_id    => g.branch_id,
    _is_opening_entry => false,
    _amounts_in_document_currency => false);

  UPDATE public.mf_fee_collections SET journal_entry_id = v_je WHERE id = v_collection;
  UPDATE public.mf_client_charge_payments SET journal_entry_id = v_je WHERE id = ANY(v_pay_ids);

  RETURN v_collection;
END;
$fn$;