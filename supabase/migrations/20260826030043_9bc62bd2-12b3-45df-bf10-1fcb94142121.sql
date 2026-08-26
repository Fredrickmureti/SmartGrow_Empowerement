ALTER TABLE public.fixed_assets
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS acquisition_exchange_rate numeric,
  ADD COLUMN IF NOT EXISTS base_purchase_price numeric,
  ADD COLUMN IF NOT EXISTS base_residual_value numeric,
  ADD COLUMN IF NOT EXISTS disposal_exchange_rate numeric,
  ADD COLUMN IF NOT EXISTS base_disposal_price numeric;

COMMENT ON COLUMN public.fixed_assets.currency IS 'Transaction currency the asset was acquired in. Immutable once depreciated or posted.';
COMMENT ON COLUMN public.fixed_assets.acquisition_exchange_rate IS 'Rate resolved server-side on purchase_date by the one FX engine. IAS 21 historical rate for this non-monetary asset.';
COMMENT ON COLUMN public.fixed_assets.base_purchase_price IS 'purchase_price x acquisition_exchange_rate. The accounting basis for depreciation, carrying value and GL.';
COMMENT ON COLUMN public.fixed_assets.base_residual_value IS 'residual_value x acquisition_exchange_rate.';
COMMENT ON COLUMN public.fixed_assets.disposal_exchange_rate IS 'Rate on disposal_date. Proceeds are monetary and translated at the disposal date, not the historical rate.';
COMMENT ON COLUMN public.fixed_assets.base_disposal_price IS 'disposal_price x disposal_exchange_rate.';

-- Label existing rows: they were implicitly base currency. No amount is re-valued.
UPDATE public.fixed_assets fa
SET currency = b.base_currency,
    acquisition_exchange_rate = 1,
    base_purchase_price = fa.purchase_price,
    base_residual_value = COALESCE(fa.residual_value, 0),
    disposal_exchange_rate = CASE WHEN fa.disposal_date IS NOT NULL THEN 1 END,
    base_disposal_price = CASE WHEN fa.disposal_date IS NOT NULL THEN fa.disposal_price END
FROM public.businesses b
WHERE b.id = fa.business_id
  AND fa.currency IS NULL;

CREATE OR REPLACE FUNCTION public._tg_stamp_fixed_asset_currency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  s record;
  d record;
  _locked boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    _locked := EXISTS (SELECT 1 FROM public.depreciation_entries de WHERE de.asset_id = OLD.id)
            OR public._fx_document_is_posted_any(ARRAY['asset_acquisition'], OLD.id);

    IF _locked
       AND (NEW.currency IS DISTINCT FROM OLD.currency
            OR NEW.acquisition_exchange_rate IS DISTINCT FROM OLD.acquisition_exchange_rate
            OR NEW.purchase_date IS DISTINCT FROM OLD.purchase_date
            OR NEW.purchase_price IS DISTINCT FROM OLD.purchase_price) THEN
      RAISE EXCEPTION 'Acquisition currency, rate, date and cost of a depreciated or posted asset are immutable (IAS 21 historical rate)'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT'
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.purchase_date IS DISTINCT FROM OLD.purchase_date
     OR NEW.acquisition_exchange_rate IS NULL
     OR NEW.acquisition_exchange_rate <= 0 THEN
    SELECT * INTO s FROM public.fx_stamp_document(NEW.organization_id, NEW.business_id, NEW.currency, NEW.purchase_date);
    NEW.currency := s.currency;
    NEW.acquisition_exchange_rate := s.rate;
  END IF;

  NEW.base_purchase_price := round(COALESCE(NEW.purchase_price, 0) * NEW.acquisition_exchange_rate, 4);
  NEW.base_residual_value := round(COALESCE(NEW.residual_value, 0) * NEW.acquisition_exchange_rate, 4);

  IF NEW.disposal_date IS NULL THEN
    NEW.disposal_exchange_rate := NULL;
    NEW.base_disposal_price := NULL;
  ELSE
    IF TG_OP = 'UPDATE'
       AND OLD.disposal_date IS NOT NULL
       AND public._fx_document_is_posted_any(ARRAY['asset_disposal'], OLD.id)
       AND (NEW.disposal_date IS DISTINCT FROM OLD.disposal_date
            OR NEW.disposal_price IS DISTINCT FROM OLD.disposal_price
            OR NEW.disposal_exchange_rate IS DISTINCT FROM OLD.disposal_exchange_rate) THEN
      RAISE EXCEPTION 'Disposal date, proceeds and rate of a posted disposal are immutable'
        USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'INSERT'
       OR OLD.disposal_date IS DISTINCT FROM NEW.disposal_date
       OR OLD.disposal_price IS DISTINCT FROM NEW.disposal_price
       OR NEW.disposal_exchange_rate IS NULL
       OR NEW.disposal_exchange_rate <= 0 THEN
      SELECT * INTO d FROM public.fx_stamp_document(NEW.organization_id, NEW.business_id, NEW.currency, NEW.disposal_date);
      NEW.disposal_exchange_rate := d.rate;
    END IF;
    NEW.base_disposal_price := round(COALESCE(NEW.disposal_price, 0) * NEW.disposal_exchange_rate, 4);
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.book_value := round(NEW.base_purchase_price - COALESCE(NEW.accumulated_depreciation, 0), 4);
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._tg_stamp_fixed_asset_currency() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_fixed_assets_stamp_currency ON public.fixed_assets;
CREATE TRIGGER trg_fixed_assets_stamp_currency
  BEFORE INSERT OR UPDATE ON public.fixed_assets
  FOR EACH ROW EXECUTE FUNCTION public._tg_stamp_fixed_asset_currency();

ALTER TABLE public.fixed_assets
  ALTER COLUMN currency SET NOT NULL,
  ALTER COLUMN acquisition_exchange_rate SET NOT NULL,
  ALTER COLUMN base_purchase_price SET NOT NULL,
  ALTER COLUMN base_residual_value SET NOT NULL;

ALTER TABLE public.fixed_assets
  ADD CONSTRAINT fixed_assets_acquisition_rate_positive CHECK (acquisition_exchange_rate > 0),
  ADD CONSTRAINT fixed_assets_disposal_rate_positive CHECK (disposal_exchange_rate IS NULL OR disposal_exchange_rate > 0);