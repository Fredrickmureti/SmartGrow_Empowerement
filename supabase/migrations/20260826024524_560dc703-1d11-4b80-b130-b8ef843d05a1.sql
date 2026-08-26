REVOKE ALL ON public.business_currency_change_audit FROM public, anon, authenticated;
GRANT SELECT ON public.business_currency_change_audit TO authenticated;
GRANT ALL ON public.business_currency_change_audit TO service_role;