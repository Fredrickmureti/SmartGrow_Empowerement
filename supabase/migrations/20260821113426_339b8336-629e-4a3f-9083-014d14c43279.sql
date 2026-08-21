-- FX Foundation Step 0: close anon EXECUTE leaks on FX surfaces.

CREATE OR REPLACE FUNCTION public.describe_exchange_rate(
  p_org_id uuid, p_business_id uuid, p_currency text, p_on_date date)
RETURNS TABLE(rate numeric, source text, provider_key text, effective_date date, scope text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_base text;
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'Not authorised for this business' USING ERRCODE = '42501';
  END IF;

  SELECT base_currency INTO v_base FROM public.businesses WHERE id = p_business_id;
  IF p_currency IS NULL OR v_base IS NULL OR upper(p_currency) = upper(v_base) THEN
    RETURN QUERY SELECT 1::numeric, 'base'::text, NULL::text, COALESCE(p_on_date, CURRENT_DATE), 'identity'::text;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT er.rate, er.source, er.provider_key, er.effective_date,
         CASE WHEN er.business_id IS NULL THEN 'organization' ELSE 'business' END
    FROM public.exchange_rates er
   WHERE er.organization_id = p_org_id
     AND upper(er.from_currency) = upper(p_currency)
     AND upper(er.to_currency) = upper(v_base)
     AND er.effective_date <= COALESCE(p_on_date, CURRENT_DATE)
     AND (er.business_id IS NULL OR er.business_id = p_business_id)
   ORDER BY
     er.effective_date DESC,
     (er.business_id IS NOT NULL) DESC,
     CASE er.source WHEN 'override' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END,
     er.published_at DESC
   LIMIT 1;
END;
$function$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fx_stamp_document','describe_exchange_rate',
                         'resolve_fx_realized_account','set_exchange_rate_override',
                         'resolve_sales_exchange_rate','_fx_document_is_posted')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, PUBLIC', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END $$;