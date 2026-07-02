-- Remove the redundant SKU-sync trigger; the broader trigger
-- (sync_product_identifiers_from_product) already syncs SKU and PLU.
DROP TRIGGER IF EXISTS trg_sync_product_sku_to_identifiers ON public.products;
DROP FUNCTION IF EXISTS public.sync_product_sku_to_identifiers();

-- Correct the ON CONFLICT target: the unique indexes are on the generated
-- column code_norm (= lower(code)), not the expression lower(code).
CREATE OR REPLACE FUNCTION public.sync_product_identifiers_from_product()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sku IS NOT NULL AND length(trim(NEW.sku)) > 0 THEN
    INSERT INTO public.product_identifiers (organization_id, business_id, product_id, code, kind, is_primary)
    VALUES (NEW.organization_id, NEW.business_id, NEW.id, NEW.sku, 'sku',
            NOT EXISTS (SELECT 1 FROM public.product_identifiers WHERE product_id = NEW.id AND is_primary))
    ON CONFLICT (business_id, code_norm) DO NOTHING;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.sku IS DISTINCT FROM NEW.sku AND OLD.sku IS NOT NULL THEN
    DELETE FROM public.product_identifiers
    WHERE product_id = NEW.id AND kind = 'sku' AND lower(code) = lower(OLD.sku)
      AND (NEW.sku IS NULL OR lower(NEW.sku) <> lower(OLD.sku));
  END IF;

  IF NEW.plu_code IS NOT NULL AND length(trim(NEW.plu_code)) > 0 THEN
    INSERT INTO public.product_identifiers (organization_id, business_id, product_id, code, kind, is_primary)
    VALUES (NEW.organization_id, NEW.business_id, NEW.id, NEW.plu_code, 'plu', false)
    ON CONFLICT (business_id, code_norm) DO NOTHING;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.plu_code IS DISTINCT FROM NEW.plu_code AND OLD.plu_code IS NOT NULL THEN
    DELETE FROM public.product_identifiers
    WHERE product_id = NEW.id AND kind = 'plu' AND lower(code) = lower(OLD.plu_code)
      AND (NEW.plu_code IS NULL OR lower(NEW.plu_code) <> lower(OLD.plu_code));
  END IF;

  RETURN NEW;
END;
$$;