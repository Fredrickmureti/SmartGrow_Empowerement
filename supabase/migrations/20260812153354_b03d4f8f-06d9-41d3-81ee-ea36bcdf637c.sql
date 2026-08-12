-- Canonical supplier item terms write seam (ADR-0079 party/role split).
-- Callers pass the PARTY (contact) id; the function resolves the supplier role.
CREATE OR REPLACE FUNCTION public.upsert_supplier_item_terms(
  p_business_id uuid,
  p_vendor_id uuid,
  p_product_id uuid,
  p_unit_price numeric,
  p_currency_code text DEFAULT NULL,
  p_min_order_qty numeric DEFAULT NULL,
  p_lead_time_days integer DEFAULT NULL,
  p_is_preferred boolean DEFAULT false,
  p_effective_from date DEFAULT NULL,
  p_effective_to date DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_branch_id uuid DEFAULT NULL,
  p_organization_id uuid DEFAULT NULL,
  p_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_supplier_id uuid;
  v_org uuid := p_organization_id;
  v_id uuid;
BEGIN
  PERFORM public._assert_org_member(
    (SELECT b.organization_id FROM public.businesses b WHERE b.id = p_business_id)
  );

  IF v_org IS NULL THEN
    SELECT b.organization_id INTO v_org FROM public.businesses b WHERE b.id = p_business_id;
  END IF;

  v_supplier_id := public.ensure_supplier_for_contact(p_vendor_id);
  IF v_supplier_id IS NULL THEN
    RAISE EXCEPTION 'Vendor % is not a supplier party', p_vendor_id;
  END IF;

  -- Preferred is exclusive per product within the same branch scope.
  IF COALESCE(p_is_preferred, false) THEN
    UPDATE public.supplier_item_terms t
       SET preferred_rank = 10, updated_at = now(), updated_by = auth.uid()
     WHERE t.business_id = p_business_id
       AND t.product_id = p_product_id
       AND t.preferred_rank <= 1
       AND (p_id IS NULL OR t.id <> p_id)
       AND ((p_branch_id IS NULL AND t.branch_id IS NULL) OR t.branch_id = p_branch_id);
  END IF;

  IF p_id IS NOT NULL THEN
    UPDATE public.supplier_item_terms
       SET supplier_id     = v_supplier_id,
           product_id      = p_product_id,
           unit_price      = COALESCE(p_unit_price, unit_price),
           currency_code   = COALESCE(p_currency_code, currency_code),
           min_order_qty   = COALESCE(p_min_order_qty, min_order_qty),
           lead_time_days  = COALESCE(p_lead_time_days, lead_time_days),
           preferred_rank  = CASE WHEN COALESCE(p_is_preferred, false) THEN 1 ELSE 10 END,
           effective_from  = COALESCE(p_effective_from, effective_from),
           effective_to    = p_effective_to,
           notes           = p_notes,
           branch_id       = p_branch_id,
           updated_by      = auth.uid(),
           updated_at      = now()
     WHERE id = p_id AND business_id = p_business_id
     RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'supplier_item_terms % not found for business %', p_id, p_business_id;
    END IF;
    RETURN v_id;
  END IF;

  INSERT INTO public.supplier_item_terms (
    organization_id, business_id, branch_id, supplier_id, product_id,
    unit_price, currency_code, min_order_qty, lead_time_days, preferred_rank,
    effective_from, effective_to, notes, is_active, created_by
  ) VALUES (
    v_org, p_business_id, p_branch_id, v_supplier_id, p_product_id,
    p_unit_price, COALESCE(p_currency_code, 'KES'), COALESCE(p_min_order_qty, 1),
    COALESCE(p_lead_time_days, 0),
    CASE WHEN COALESCE(p_is_preferred, false) THEN 1 ELSE 10 END,
    COALESCE(p_effective_from, CURRENT_DATE), p_effective_to, p_notes, true, auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.deactivate_supplier_item_terms(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_business uuid;
BEGIN
  SELECT business_id INTO v_business FROM public.supplier_item_terms WHERE id = p_id;
  IF v_business IS NULL THEN
    RAISE EXCEPTION 'supplier_item_terms % not found', p_id;
  END IF;
  PERFORM public._assert_org_member(
    (SELECT b.organization_id FROM public.businesses b WHERE b.id = v_business)
  );
  UPDATE public.supplier_item_terms
     SET is_active = false, updated_by = auth.uid(), updated_at = now()
   WHERE id = p_id;
END $$;

REVOKE ALL ON FUNCTION public.upsert_supplier_item_terms(uuid,uuid,uuid,numeric,text,numeric,integer,boolean,date,date,text,uuid,uuid,uuid) FROM public;
REVOKE ALL ON FUNCTION public.deactivate_supplier_item_terms(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.upsert_supplier_item_terms(uuid,uuid,uuid,numeric,text,numeric,integer,boolean,date,date,text,uuid,uuid,uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deactivate_supplier_item_terms(uuid) TO authenticated, service_role;

-- Retire the compatibility view: all writers now call the RPCs above and all
-- readers query supplier_item_terms directly.
DROP TRIGGER IF EXISTS trg_vendor_pricelists_dml ON public.vendor_pricelists;
DROP VIEW IF EXISTS public.vendor_pricelists;
DROP FUNCTION IF EXISTS public._vendor_pricelists_dml();