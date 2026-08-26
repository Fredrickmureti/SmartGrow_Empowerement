CREATE OR REPLACE FUNCTION public._tg_exchange_rates_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF NEW.rate IS NULL OR NEW.rate <= 0 THEN
    RAISE EXCEPTION 'An exchange rate must be greater than zero' USING ERRCODE = '22023';
  END IF;

  -- Interactive callers must be finance managers of the company. A NULL actor is
  -- the publishing job (service role); a platform admin publishing provider
  -- reference rates is likewise not a company finance role and is allowed.
  IF v_actor IS NOT NULL
     AND NOT (NEW.source = 'provider' AND public.is_platform_admin(v_actor)) THEN
    IF NOT public.user_can_access_business(v_actor, NEW.business_id) THEN
      RAISE EXCEPTION 'Not authorised for this company' USING ERRCODE = '42501';
    END IF;
    IF NOT public.is_finance_manager(v_actor, NEW.organization_id) THEN
      RAISE EXCEPTION 'Recording an exchange rate requires a finance role (owner, admin or accountant)'
        USING ERRCODE = '42501';
    END IF;
    NEW.created_by := COALESCE(NEW.created_by, v_actor);
  END IF;

  -- A tenant-entered rate dated into a closed period would silently rewrite the
  -- basis of already-reported figures. Provider publishing is deliberately exempt:
  -- it is reference data, and resolution still prefers a tenant override.
  IF NEW.source <> 'provider' AND EXISTS (
    SELECT 1 FROM public.fiscal_periods fp
     WHERE fp.business_id = NEW.business_id
       AND NEW.effective_date BETWEEN fp.start_date AND fp.end_date
       AND fp.status::text <> 'open'
  ) THEN
    RAISE EXCEPTION
      'The accounting period covering % is closed; an exchange rate cannot be dated into it. Reopen the period or date the rate in an open one.',
      NEW.effective_date
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._tg_exchange_rates_write_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._tg_exchange_rates_write_guard() TO service_role;