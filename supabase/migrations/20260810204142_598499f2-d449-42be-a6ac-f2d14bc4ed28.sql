CREATE OR REPLACE FUNCTION public._rfq_quotation_item_validate_alternate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rfq public.rfqs;
  v_prod RECORD;
BEGIN
  IF NEW.is_alternate IS TRUE AND NEW.alternate_product_id IS NULL THEN
    RAISE EXCEPTION 'An alternate offer must name the substitute product';
  END IF;

  IF NEW.alternate_product_id IS NULL THEN
    NEW.is_alternate := false;
    RETURN NEW;
  END IF;

  NEW.is_alternate := true;

  IF NEW.product_id IS NOT NULL AND NEW.alternate_product_id = NEW.product_id THEN
    RAISE EXCEPTION 'The alternate product must differ from the requested product';
  END IF;

  SELECT r.* INTO v_rfq
    FROM public.rfqs r
    JOIN public.rfq_quotations q ON q.rfq_id = r.id
   WHERE q.id = NEW.quotation_id;

  SELECT p.id, p.organization_id, p.business_id, p.is_active
    INTO v_prod
    FROM public.products p
   WHERE p.id = NEW.alternate_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Alternate product not found';
  END IF;
  IF v_prod.organization_id IS DISTINCT FROM v_rfq.organization_id THEN
    RAISE EXCEPTION 'Alternate product belongs to another organization';
  END IF;
  IF v_rfq.business_id IS NOT NULL
     AND v_prod.business_id IS NOT NULL
     AND v_prod.business_id IS DISTINCT FROM v_rfq.business_id THEN
    RAISE EXCEPTION 'Alternate product belongs to another business';
  END IF;
  IF v_prod.is_active IS FALSE THEN
    RAISE EXCEPTION 'Alternate product is not active';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rfq_quotation_item_validate_alternate ON public.rfq_quotation_items;
CREATE TRIGGER trg_rfq_quotation_item_validate_alternate
  BEFORE INSERT OR UPDATE OF is_alternate, alternate_product_id
  ON public.rfq_quotation_items
  FOR EACH ROW EXECUTE FUNCTION public._rfq_quotation_item_validate_alternate();