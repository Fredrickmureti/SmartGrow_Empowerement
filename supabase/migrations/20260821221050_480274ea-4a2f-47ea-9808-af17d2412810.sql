CREATE OR REPLACE FUNCTION public.to_base_amount(_business_id uuid, _currency text, _amount numeric, _as_of date DEFAULT CURRENT_DATE)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org  uuid;
  v_base text;
  v_rate numeric;
BEGIN
  IF _amount IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT b.organization_id, b.base_currency
    INTO v_org, v_base
    FROM public.businesses b
   WHERE b.id = _business_id;

  IF v_org IS NULL THEN
    RETURN NULL;
  END IF;

  -- Isolation: a signed-in caller may only translate amounts for a business they
  -- can access. Internal SECURITY DEFINER callers (auth.uid() IS NULL) pass through.
  IF auth.uid() IS NOT NULL
     AND NOT public.user_can_access_business(auth.uid(), _business_id) THEN
    RAISE EXCEPTION 'Not authorised for this business' USING ERRCODE = '42501';
  END IF;

  IF _currency IS NULL OR v_base IS NULL OR upper(_currency) = upper(v_base) THEN
    RETURN _amount::numeric;
  END IF;

  -- ADR 0136: one resolver, one precedence. NULL when no rate is on file — never
  -- the unconverted foreign amount, which would be a silent 1:1.
  v_rate := public.resolve_exchange_rate(v_org, _business_id, _currency, COALESCE(_as_of, CURRENT_DATE));
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RETURN NULL;
  END IF;

  RETURN (_amount * v_rate)::numeric;
END;
$function$;

REVOKE ALL ON FUNCTION public.to_base_amount(uuid, text, numeric, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.to_base_amount(uuid, text, numeric, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.to_base_amount(uuid, text, numeric, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.to_base_amount(uuid, text, numeric, date) TO service_role;