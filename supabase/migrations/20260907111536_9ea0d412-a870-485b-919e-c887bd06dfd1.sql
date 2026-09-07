UPDATE public.businesses SET base_currency = 'KES' WHERE base_currency IS DISTINCT FROM 'KES';

ALTER TABLE public.businesses
  ADD CONSTRAINT businesses_base_currency_kes_only
  CHECK (base_currency = 'KES') NOT VALID;

ALTER TABLE public.businesses VALIDATE CONSTRAINT businesses_base_currency_kes_only;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('change_business_base_currency', 'set_exchange_rate_override', 'set_business_active_currency')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated, anon', r.sig);
  END LOOP;
END $$;