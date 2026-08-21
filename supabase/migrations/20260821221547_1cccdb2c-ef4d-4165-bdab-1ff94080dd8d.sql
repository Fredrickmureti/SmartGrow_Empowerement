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

  v_currency := COALESCE(_currency, (SELECT base_currency FROM public.businesses WHERE id = _business_id), 'KES');
  v_base := public.to_base_amount(_business_id, v_currency, _promised_amount, CURRENT_DATE);
  -- ADR 0136: no silent parity — refuse rather than book a 1:1 base figure.
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