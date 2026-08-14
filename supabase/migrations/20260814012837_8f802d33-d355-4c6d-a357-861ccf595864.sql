-- Phase 5B: supplier_item_terms becomes the canonical owner of purchasing terms.

ALTER TABLE public.supplier_item_terms
  ADD COLUMN IF NOT EXISTS order_increment numeric,
  ADD COLUMN IF NOT EXISTS purchase_uom_id uuid REFERENCES public.units_of_measure(id);

COMMENT ON COLUMN public.supplier_item_terms.order_increment IS
  'Canonical order multiple for this supplier/product. NULL = fall back to products.order_quantity_increment (deprecated default).';
COMMENT ON COLUMN public.supplier_item_terms.purchase_uom_id IS
  'UoM the supplier quotes/sells in. NULL = product purchase/base UoM.';
COMMENT ON COLUMN public.products.min_order_quantity IS
  'DEPRECATED product-level default. Canonical owner is supplier_item_terms.min_order_qty (resolve_supplier_purchasing_terms).';
COMMENT ON COLUMN public.products.order_quantity_increment IS
  'DEPRECATED product-level default. Canonical owner is supplier_item_terms.order_increment (resolve_supplier_purchasing_terms).';

ALTER TABLE public.supplier_item_terms
  DROP CONSTRAINT IF EXISTS supplier_item_terms_order_increment_positive;
ALTER TABLE public.supplier_item_terms
  ADD CONSTRAINT supplier_item_terms_order_increment_positive
  CHECK (order_increment IS NULL OR order_increment > 0);

-- One resolver. Effective-dated supplier terms first, deprecated product
-- defaults as fallback, with the provenance of every value.
CREATE OR REPLACE FUNCTION public.resolve_supplier_purchasing_terms(
  p_business_id uuid,
  p_product_id  uuid,
  p_supplier_id uuid DEFAULT NULL,
  p_on_date     date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  product_id        uuid,
  supplier_id       uuid,
  terms_id          uuid,
  min_order_qty     numeric,
  min_order_source  text,
  order_increment   numeric,
  increment_source  text,
  lead_time_days    integer,
  lead_time_source  text,
  currency_code     text,
  purchase_uom_id   uuid,
  unit_price        numeric,
  effective_from    date,
  effective_to      date
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_t public.supplier_item_terms;
  v_p RECORD;
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

  IF p_supplier_id IS NOT NULL THEN
    SELECT t.* INTO v_t
    FROM public.supplier_item_terms t
    WHERE t.business_id = p_business_id
      AND t.product_id  = p_product_id
      AND t.supplier_id = p_supplier_id
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
$$;

COMMENT ON FUNCTION public.resolve_supplier_purchasing_terms(uuid, uuid, uuid, date) IS
  'Canonical read seam for purchasing terms. Supplier effective-dated terms win over deprecated product-level defaults; every value carries its source.';

-- Quantity validation lives in SQL next to the resolver, never in the browser.
CREATE OR REPLACE FUNCTION public.validate_supplier_order_quantity(
  p_business_id uuid,
  p_product_id  uuid,
  p_supplier_id uuid,
  p_quantity    numeric,
  p_on_date     date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  is_valid          boolean,
  reason            text,
  min_order_qty     numeric,
  order_increment   numeric,
  adjusted_quantity numeric,
  min_order_source  text,
  increment_source  text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v RECORD;
  v_adjusted numeric;
  v_steps numeric;
BEGIN
  SELECT * INTO v
  FROM public.resolve_supplier_purchasing_terms(p_business_id, p_product_id, p_supplier_id, p_on_date);

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN QUERY SELECT false, 'QUANTITY_NOT_POSITIVE', v.min_order_qty, v.order_increment,
                        v.min_order_qty, v.min_order_source, v.increment_source;
    RETURN;
  END IF;

  IF p_quantity < v.min_order_qty THEN
    RETURN QUERY SELECT false, 'BELOW_MIN_ORDER_QTY', v.min_order_qty, v.order_increment,
                        v.min_order_qty, v.min_order_source, v.increment_source;
    RETURN;
  END IF;

  v_steps := (p_quantity - v.min_order_qty) / v.order_increment;
  IF v_steps <> trunc(v_steps) THEN
    v_adjusted := v.min_order_qty + ceil(v_steps) * v.order_increment;
    RETURN QUERY SELECT false, 'NOT_ON_ORDER_INCREMENT', v.min_order_qty, v.order_increment,
                        v_adjusted, v.min_order_source, v.increment_source;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, NULL::text, v.min_order_qty, v.order_increment,
                      p_quantity, v.min_order_source, v.increment_source;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_supplier_purchasing_terms(uuid, uuid, uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_supplier_order_quantity(uuid, uuid, uuid, numeric, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_supplier_purchasing_terms(uuid, uuid, uuid, date) FROM anon;
REVOKE ALL ON FUNCTION public.validate_supplier_order_quantity(uuid, uuid, uuid, numeric, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_supplier_purchasing_terms(uuid, uuid, uuid, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.validate_supplier_order_quantity(uuid, uuid, uuid, numeric, date) TO authenticated, service_role;