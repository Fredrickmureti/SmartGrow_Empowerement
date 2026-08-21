-- ADR 0136: no currency literal anywhere. A missing base currency is a
-- configuration error, not a reason to assume KES.
ALTER TABLE public.ar_disputes ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE public.ar_promises_to_pay ALTER COLUMN currency DROP DEFAULT;

CREATE OR REPLACE FUNCTION public.raise_ar_dispute(_business_id uuid, _contact_id uuid, _amount_disputed numeric, _dispute_type text DEFAULT 'other'::text, _reason text DEFAULT NULL::text, _currency text DEFAULT NULL::text, _document_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _client_request_id text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  v_currency text;
  v_base numeric;
  v_existing uuid;
  v_id uuid;
BEGIN
  SELECT b.organization_id INTO v_org FROM public.businesses b WHERE b.id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Business not found';
  END IF;
  IF NOT public.is_org_member(auth.uid(), v_org) THEN
    RAISE EXCEPTION 'Not authorized for this organization';
  END IF;
  IF _amount_disputed IS NULL OR _amount_disputed < 0 THEN
    RAISE EXCEPTION 'Disputed amount cannot be negative';
  END IF;

  IF _client_request_id IS NOT NULL THEN
    SELECT id INTO v_existing FROM public.ar_disputes
    WHERE organization_id = v_org AND client_request_id = _client_request_id;
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- ADR 0136: derive, never assume. No currency literal.
  v_currency := NULLIF(UPPER(TRIM(COALESCE(_currency, (SELECT base_currency FROM public.businesses WHERE id = _business_id)))), '');
  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'No currency supplied and this business has no base currency configured'
      USING ERRCODE = '23514';
  END IF;

  v_base := public.to_base_amount(_business_id, v_currency, _amount_disputed, CURRENT_DATE);
  -- No silent parity. base_amount_disputed is NOT NULL, so a missing rate must refuse.
  IF v_base IS NULL THEN
    RAISE EXCEPTION 'No exchange rate on file for % on %. Add a rate override in Currency settings before raising a dispute in this currency.',
      v_currency, CURRENT_DATE USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.ar_disputes (
    organization_id, business_id, branch_id, contact_id, document_id,
    dispute_type, reason, amount_disputed, currency, base_amount_disputed,
    client_request_id, raised_by
  ) VALUES (
    v_org, _business_id, _branch_id, _contact_id, _document_id,
    COALESCE(_dispute_type, 'other'), _reason, _amount_disputed, v_currency, v_base,
    _client_request_id, auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_promise_to_pay(_business_id uuid, _contact_id uuid, _promised_amount numeric, _expected_payment_date date, _currency text DEFAULT NULL::text, _document_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _notes text DEFAULT NULL::text, _client_request_id text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  v_currency text;
  v_base numeric;
  v_baseline numeric;
  v_existing uuid;
  v_id uuid;
BEGIN
  SELECT b.organization_id INTO v_org FROM public.businesses b WHERE b.id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Business not found';
  END IF;
  IF NOT public.is_org_member(auth.uid(), v_org) THEN
    RAISE EXCEPTION 'Not authorized for this organization';
  END IF;
  IF _promised_amount IS NULL OR _promised_amount <= 0 THEN
    RAISE EXCEPTION 'Promised amount must be positive';
  END IF;

  IF _client_request_id IS NOT NULL THEN
    SELECT id INTO v_existing FROM public.ar_promises_to_pay
    WHERE organization_id = v_org AND client_request_id = _client_request_id;
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  v_currency := NULLIF(UPPER(TRIM(COALESCE(_currency, (SELECT base_currency FROM public.businesses WHERE id = _business_id)))), '');
  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'No currency supplied and this business has no base currency configured'
      USING ERRCODE = '23514';
  END IF;

  v_base := public.to_base_amount(_business_id, v_currency, _promised_amount, CURRENT_DATE);
  IF v_base IS NULL THEN
    RAISE EXCEPTION 'No exchange rate on file for % on %. Add a rate override in Currency settings before recording a promise in this currency.',
      v_currency, CURRENT_DATE USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(np.net_amount), 0) INTO v_baseline
  FROM public.finance_ar_net_position np
  WHERE np.organization_id = v_org
    AND np.business_id = _business_id
    AND np.contact_id = _contact_id;

  INSERT INTO public.ar_promises_to_pay (
    organization_id, business_id, branch_id, contact_id, document_id,
    promised_amount, currency, base_promised_amount, expected_payment_date,
    notes, baseline_residual, client_request_id, created_by
  ) VALUES (
    v_org, _business_id, _branch_id, _contact_id, _document_id,
    _promised_amount, v_currency, v_base, _expected_payment_date,
    _notes, v_baseline, _client_request_id, auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;