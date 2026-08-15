-- Phase 3 — purchasing terms must be reachable from a purchasing document.
-- Purchases keys vendor_id -> contacts.id (party, ADR-0079) while
-- supplier_item_terms.supplier_id -> suppliers.id (role). The party->role hop
-- belongs on the server, next to the resolver, not in the browser.

CREATE OR REPLACE FUNCTION public._resolve_supplier_role_id(
  p_business_id uuid,
  p_party_or_role_id uuid
) RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    (SELECT s.id FROM public.suppliers s
      WHERE s.id = p_party_or_role_id AND s.business_id = p_business_id),
    (SELECT s.id FROM public.suppliers s
      WHERE s.contact_id = p_party_or_role_id AND s.business_id = p_business_id
      ORDER BY s.archived_at NULLS FIRST, s.created_at
      LIMIT 1)
  );
$$;

REVOKE ALL ON FUNCTION public._resolve_supplier_role_id(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._resolve_supplier_role_id(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_supplier_purchasing_terms(
  p_business_id uuid,
  p_product_id uuid,
  p_supplier_id uuid DEFAULT NULL::uuid,
  p_on_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE(product_id uuid, supplier_id uuid, terms_id uuid, min_order_qty numeric,
              min_order_source text, order_increment numeric, increment_source text,
              lead_time_days integer, lead_time_source text, currency_code text,
              purchase_uom_id uuid, unit_price numeric, effective_from date, effective_to date)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_t public.supplier_item_terms;
  v_p RECORD;
  v_supplier uuid;
BEGIN
  IF NOT public.user_has_business_access(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'SUPPLIER_TERMS_FORBIDDEN: no access to business %', p_business_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT p.id, p.business_id, p.min_order_quantity, p.order_quantity_increment,
         p.purchase_uom_id, p.base_uom_id
    INTO v_p
  FROM public.products p
  WHERE p.id = p_product_id AND p.business_id = p_business_id;

  IF v_p.id IS NULL THEN
    RAISE EXCEPTION 'SUPPLIER_TERMS_PRODUCT_NOT_FOUND: product % is not in business %',
      p_product_id, p_business_id;
  END IF;

  -- Callers may name the supplier party (contacts.id) or the supplier role.
  v_supplier := CASE
    WHEN p_supplier_id IS NULL THEN NULL
    ELSE public._resolve_supplier_role_id(p_business_id, p_supplier_id)
  END;

  IF v_supplier IS NOT NULL THEN
    SELECT t.* INTO v_t
    FROM public.supplier_item_terms t
    WHERE t.business_id = p_business_id
      AND t.product_id  = p_product_id
      AND t.supplier_id = v_supplier
      AND t.is_active
      AND t.effective_from <= p_on_date
      AND (t.effective_to IS NULL OR t.effective_to >= p_on_date)
    ORDER BY t.preferred_rank, t.effective_from DESC
    LIMIT 1;
  ELSE
    -- No supplier named: use the preferred active supplier for this product.
    SELECT t.* INTO v_t
    FROM public.supplier_item_terms t
    WHERE t.business_id = p_business_id
      AND t.product_id  = p_product_id
      AND t.is_active
      AND t.effective_from <= p_on_date
      AND (t.effective_to IS NULL OR t.effective_to >= p_on_date)
    ORDER BY t.preferred_rank, t.effective_from DESC
    LIMIT 1;
  END IF;

  RETURN QUERY SELECT
    p_product_id,
    v_t.supplier_id,
    v_t.id,
    COALESCE(v_t.min_order_qty, v_p.min_order_quantity, 1)::numeric,
    CASE WHEN v_t.min_order_qty IS NOT NULL THEN 'supplier'
         WHEN v_p.min_order_quantity IS NOT NULL THEN 'product_default'
         ELSE 'system_default' END,
    COALESCE(v_t.order_increment, v_p.order_quantity_increment, 1)::numeric,
    CASE WHEN v_t.order_increment IS NOT NULL THEN 'supplier'
         WHEN v_p.order_quantity_increment IS NOT NULL THEN 'product_default'
         ELSE 'system_default' END,
    v_t.lead_time_days,
    CASE WHEN v_t.lead_time_days IS NOT NULL THEN 'supplier' ELSE 'system_default' END,
    v_t.currency_code,
    COALESCE(v_t.purchase_uom_id, v_p.purchase_uom_id, v_p.base_uom_id),
    v_t.unit_price,
    v_t.effective_from,
    v_t.effective_to;
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_supplier_purchasing_terms(uuid, uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_supplier_purchasing_terms(uuid, uuid, uuid, date) TO authenticated, service_role;
