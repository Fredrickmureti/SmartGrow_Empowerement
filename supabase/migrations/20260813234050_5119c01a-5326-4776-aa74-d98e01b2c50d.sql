-- Backstop for the legacy create path, which still derived jurisdiction from
-- the country of origin. Explicit foreign jurisdictions remain possible
-- (jurisdiction <> origin_country), only the conflated case is corrected.
CREATE OR REPLACE FUNCTION public._normalize_localization_jurisdiction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_home text;
BEGIN
  v_home := public.resolve_fiscal_jurisdiction(NEW.business_id);
  IF NEW.jurisdiction IS NULL
     OR (NEW.jurisdiction = NEW.origin_country AND NEW.jurisdiction <> v_home) THEN
    NEW.jurisdiction := v_home;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_localization_jurisdiction ON public.product_tax_localization;
CREATE TRIGGER trg_normalize_localization_jurisdiction
BEFORE INSERT OR UPDATE ON public.product_tax_localization
FOR EACH ROW EXECUTE FUNCTION public._normalize_localization_jurisdiction();
