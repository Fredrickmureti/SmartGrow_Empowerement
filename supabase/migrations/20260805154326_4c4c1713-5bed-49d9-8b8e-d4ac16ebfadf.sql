CREATE OR REPLACE FUNCTION public.sync_product_identifiers_from_product()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- SKU -> scannable identifier. The only unique constraint that exists on
  -- product_identifiers is the PARTIAL index
  --   (business_id, code_norm) WHERE status='active' AND supplier_id IS NULL
  -- so the ON CONFLICT target must name that predicate, otherwise Postgres
  -- raises 42P10 and the entire product INSERT is rejected.
  IF NEW.sku IS NOT NULL AND length(btrim(NEW.sku)) > 0 THEN
    INSERT INTO public.product_identifiers
      (organization_id, business_id, product_id, code, kind, is_primary)
    VALUES (
      NEW.organization_id, NEW.business_id, NEW.id, btrim(NEW.sku), 'sku',
      NOT EXISTS (
        SELECT 1 FROM public.product_identifiers
        WHERE product_id = NEW.id AND is_primary
      )
    )
    ON CONFLICT (business_id, code_norm)
      WHERE status = 'active'::product_identifier_status AND supplier_id IS NULL
      DO NOTHING;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.sku IS DISTINCT FROM NEW.sku AND OLD.sku IS NOT NULL THEN
    -- Retire, do not delete: the audit trail matters and archiving frees the
    -- code for re-issue through the partial unique index.
    UPDATE public.product_identifiers
       SET status = 'archived'::product_identifier_status,
           is_primary = false,
           valid_to = COALESCE(valid_to, now())
     WHERE product_id = NEW.id
       AND kind = 'sku'
       AND code_norm = upper(btrim(OLD.sku))
       AND status = 'active'::product_identifier_status
       AND (NEW.sku IS NULL OR upper(btrim(NEW.sku)) <> upper(btrim(OLD.sku)));
  END IF;

  IF NEW.plu_code IS NOT NULL AND length(btrim(NEW.plu_code)) > 0 THEN
    INSERT INTO public.product_identifiers
      (organization_id, business_id, product_id, code, kind, is_primary)
    VALUES (NEW.organization_id, NEW.business_id, NEW.id, btrim(NEW.plu_code), 'plu', false)
    ON CONFLICT (business_id, code_norm)
      WHERE status = 'active'::product_identifier_status AND supplier_id IS NULL
      DO NOTHING;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.plu_code IS DISTINCT FROM NEW.plu_code AND OLD.plu_code IS NOT NULL THEN
    UPDATE public.product_identifiers
       SET status = 'archived'::product_identifier_status,
           is_primary = false,
           valid_to = COALESCE(valid_to, now())
     WHERE product_id = NEW.id
       AND kind = 'plu'
       AND code_norm = upper(btrim(OLD.plu_code))
       AND status = 'active'::product_identifier_status
       AND (NEW.plu_code IS NULL OR upper(btrim(NEW.plu_code)) <> upper(btrim(OLD.plu_code)));
  END IF;

  RETURN NEW;
END;
$function$;