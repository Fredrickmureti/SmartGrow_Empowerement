-- The FX helpers below are SECURITY DEFINER but were never granted to
-- `authenticated`. Their callers (fx_rate_on, the currency-stamping triggers,
-- _expenses_derive_base_amount) are SECURITY INVOKER, so every real signed-in
-- caller failed with 42501 "permission denied for function ...". Grant the
-- callees, and scope the rate lookup to the caller's own organization so the
-- definer privilege cannot be used to read another tenant's rates.

CREATE OR REPLACE FUNCTION public._pick_exchange_rate_row(
  p_org_id uuid, p_business_id uuid, p_currency text, p_base_currency text, p_on_date date
)
RETURNS TABLE(rate numeric, source text, provider_key text, effective_date date, scope text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT er.rate, er.source, er.provider_key, er.effective_date,
         CASE WHEN er.business_id IS NULL THEN 'organization' ELSE 'business' END
    FROM public.exchange_rates er
   WHERE er.organization_id = p_org_id
     AND upper(er.from_currency) = upper(p_currency)
     AND upper(er.to_currency) = upper(p_base_currency)
     AND er.effective_date <= COALESCE(p_on_date, CURRENT_DATE)
     AND (er.business_id IS NULL OR er.business_id = p_business_id)
     -- auth.uid() IS NULL covers service_role / cron / migration contexts.
     AND (
       auth.uid() IS NULL
       OR EXISTS (
         SELECT 1 FROM public.user_business_access uba
          WHERE uba.organization_id = p_org_id AND uba.user_id = auth.uid()
       )
       OR EXISTS (
         SELECT 1 FROM public.organizations o
          WHERE o.id = p_org_id AND o.owner_user_id = auth.uid()
       )
     )
   ORDER BY
     er.effective_date DESC,
     (er.business_id IS NOT NULL) DESC,
     CASE er.source WHEN 'override' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END,
     er.published_at DESC
   LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public._pick_exchange_rate_row(uuid, uuid, text, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public._pick_exchange_rate_row(uuid, uuid, text, text, date) TO service_role;

GRANT EXECUTE ON FUNCTION public.require_exchange_rate(uuid, uuid, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.require_exchange_rate(uuid, uuid, text, date) TO service_role;

GRANT EXECUTE ON FUNCTION public.fx_stamp_document(uuid, uuid, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fx_stamp_document(uuid, uuid, text, date) TO service_role;

GRANT EXECUTE ON FUNCTION public._fx_document_is_posted_any(text[], uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public._fx_document_is_posted_any(text[], uuid) TO service_role;
