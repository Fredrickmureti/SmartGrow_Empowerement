
-- Step D (server): guarded tenant override entry + operating-currency enablement.

CREATE OR REPLACE FUNCTION public.set_exchange_rate_override(
  p_business_id uuid,
  p_from_currency text,
  p_to_currency text,
  p_rate numeric,
  p_effective_date date DEFAULT CURRENT_DATE,
  p_reason text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_from text;
  v_to text;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'Not authorised for this company' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = p_business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Business % not found', p_business_id;
  END IF;

  v_from := public.normalize_currency_code(p_from_currency);
  v_to := public.normalize_currency_code(p_to_currency);
  IF v_from IS NULL OR v_to IS NULL THEN
    RAISE EXCEPTION 'Both currencies are required' USING ERRCODE = '22023';
  END IF;
  IF v_from = v_to THEN
    RAISE EXCEPTION 'An override needs two different currencies' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.currencies WHERE code = v_from AND is_active)
     OR NOT EXISTS (SELECT 1 FROM public.currencies WHERE code = v_to AND is_active) THEN
    RAISE EXCEPTION 'Unknown or inactive currency code' USING ERRCODE = '22023';
  END IF;
  IF p_rate IS NULL OR p_rate <= 0 THEN
    RAISE EXCEPTION 'Rate must be greater than zero' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_effective_date, CURRENT_DATE) > CURRENT_DATE + 1 THEN
    RAISE EXCEPTION 'Override effective date cannot be in the future' USING ERRCODE = '22023';
  END IF;

  -- Always a new row with source = 'override': provider provenance is never mutated.
  INSERT INTO public.exchange_rates (
    organization_id, business_id, from_currency, to_currency, rate,
    effective_date, source, created_by
  ) VALUES (
    v_org, p_business_id, v_from, v_to, p_rate,
    COALESCE(p_effective_date, CURRENT_DATE), 'override', auth.uid()
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id, action, entity_type, entity_id,
    entity_name, new_values, changes_summary
  ) VALUES (
    v_org, p_business_id, auth.uid(), 'exchange_rate.override', 'exchange_rate', v_id,
    v_from || '/' || v_to,
    jsonb_build_object('rate', p_rate, 'effective_date', COALESCE(p_effective_date, CURRENT_DATE), 'source', 'override'),
    COALESCE(NULLIF(btrim(p_reason), ''), 'Manual FX override')
  );

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_exchange_rate_override(uuid, text, text, numeric, date, text) FROM public;
GRANT EXECUTE ON FUNCTION public.set_exchange_rate_override(uuid, text, text, numeric, date, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_business_active_currency(
  p_business_id uuid,
  p_currency text,
  p_enabled boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_base text;
  v_code text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'Not authorised for this company' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id, upper(base_currency) INTO v_org, v_base
    FROM public.businesses WHERE id = p_business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Business % not found', p_business_id;
  END IF;

  v_code := public.normalize_currency_code(p_currency);
  IF v_code IS NULL OR NOT EXISTS (SELECT 1 FROM public.currencies WHERE code = v_code AND is_active) THEN
    RAISE EXCEPTION 'Unknown or inactive currency code' USING ERRCODE = '22023';
  END IF;

  IF v_code = v_base AND NOT p_enabled THEN
    RAISE EXCEPTION 'The base currency of a company cannot be disabled' USING ERRCODE = '22023';
  END IF;

  -- The base currency is always present and enabled, so enabling a first
  -- foreign currency can never lock the company out of its own base currency.
  IF v_base IS NOT NULL THEN
    INSERT INTO public.business_active_currencies (organization_id, business_id, currency_code, is_enabled, created_by)
    VALUES (v_org, p_business_id, v_base, true, auth.uid())
    ON CONFLICT (business_id, currency_code) DO UPDATE SET is_enabled = true;
  END IF;

  INSERT INTO public.business_active_currencies (organization_id, business_id, currency_code, is_enabled, created_by)
  VALUES (v_org, p_business_id, v_code, p_enabled, auth.uid())
  ON CONFLICT (business_id, currency_code) DO UPDATE SET is_enabled = EXCLUDED.is_enabled;
END;
$$;

REVOKE ALL ON FUNCTION public.set_business_active_currency(uuid, text, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.set_business_active_currency(uuid, text, boolean) TO authenticated;
