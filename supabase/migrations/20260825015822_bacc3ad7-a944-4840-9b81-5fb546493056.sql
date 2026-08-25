-- CRM Phase R2 · lead-level currency ---------------------------------------
-- expected_revenue had no declared currency, so pipeline totals silently
-- assumed the business base currency. Declare it on the row.

ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS currency text;

UPDATE public.crm_leads l
   SET currency = COALESCE(b.base_currency, 'USD')
  FROM public.businesses b
 WHERE b.id = l.business_id
   AND l.currency IS NULL;

-- Any orphan rows (no matching business) still need a value before NOT NULL.
UPDATE public.crm_leads SET currency = 'USD' WHERE currency IS NULL;

ALTER TABLE public.crm_leads
  ALTER COLUMN currency SET NOT NULL;

-- Server-owned default + activation check. Currency is business-scoped
-- configuration, so the row cannot name a currency the business has not
-- activated (_assert_currency_is_active raises with an actionable message).
CREATE OR REPLACE FUNCTION public._crm_lead_currency_default()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base text;
BEGIN
  IF NEW.currency IS NULL OR btrim(NEW.currency) = '' THEN
    SELECT base_currency INTO v_base FROM public.businesses WHERE id = NEW.business_id;
    NEW.currency := COALESCE(v_base, 'USD');
  ELSE
    NEW.currency := upper(btrim(NEW.currency));
  END IF;

  IF TG_OP = 'INSERT' OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    PERFORM public._assert_currency_is_active(NEW.currency);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS crm_leads_currency_default ON public.crm_leads;
CREATE TRIGGER crm_leads_currency_default
  BEFORE INSERT OR UPDATE OF currency, business_id ON public.crm_leads
  FOR EACH ROW EXECUTE FUNCTION public._crm_lead_currency_default();

COMMENT ON COLUMN public.crm_leads.currency IS
  'Currency of expected_revenue. Defaults to the business base currency; must be an active business currency (CRM Phase R2).';