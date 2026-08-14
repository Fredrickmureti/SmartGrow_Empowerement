-- =====================================================================
-- ADR 0142 Phase 7a/7b — one availability formula, batch-capable.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.resolve_stock_availability_batch(
  p_product_ids uuid[],
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_warehouse_id uuid DEFAULT NULL::uuid,
  p_exclude_source_type text DEFAULT NULL::text,
  p_exclude_source_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(product_id uuid, on_hand numeric, reserved numeric,
              blocked numeric, in_transit numeric, available numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_product_ids IS NULL OR array_length(p_product_ids, 1) IS NULL THEN
    RETURN;
  END IF;
  IF p_business_id IS NULL AND p_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_AVAILABILITY_NO_SCOPE: a business or a warehouse is required';
  END IF;
  IF p_business_id IS NOT NULL
     AND auth.uid() IS NOT NULL
     AND NOT public.user_has_business_access(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'access denied for business %', p_business_id USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH ids AS (
    SELECT DISTINCT u AS product_id FROM unnest(p_product_ids) AS u WHERE u IS NOT NULL
  ),
  quants AS (
    SELECT
      q.product_id,
      COALESCE(SUM(q.quantity) FILTER (
        WHERE l.location_type = 'internal'
          AND COALESCE(l.is_blocked, false) = false
          AND COALESCE(w.is_in_transit, false) = false
      ), 0) AS on_hand,
      COALESCE(SUM(q.quantity) FILTER (
        WHERE l.location_type = 'quarantine' OR COALESCE(l.is_blocked, false)
      ), 0) AS blocked,
      COALESCE(SUM(q.quantity) FILTER (
        WHERE l.location_type = 'transit' OR COALESCE(w.is_in_transit, false)
      ), 0) AS in_transit
    FROM public.stock_quants q
    JOIN public.stock_locations l ON l.id = q.location_id
    LEFT JOIN public.warehouses w ON w.id = l.warehouse_id
    WHERE q.product_id = ANY (p_product_ids)
      AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id)
      AND (p_business_id  IS NULL OR q.business_id  = p_business_id)
      AND (p_branch_id    IS NULL OR q.branch_id    = p_branch_id)
    GROUP BY q.product_id
  ),
  holds AS (
    SELECT r.product_id, COALESCE(SUM(r.quantity), 0) AS reserved
    FROM public.stock_reservations r
    LEFT JOIN public.warehouses w ON w.id = r.warehouse_id
    WHERE r.product_id = ANY (p_product_ids)
      AND public.stock_reservation_is_open(r.status, r.expires_at)
      AND (p_warehouse_id IS NULL OR r.warehouse_id = p_warehouse_id)
      AND (p_business_id  IS NULL OR r.business_id  = p_business_id)
      AND (p_branch_id    IS NULL OR r.branch_id    = p_branch_id)
      AND COALESCE(w.is_in_transit, false) = false
      AND NOT (
        p_exclude_source_type IS NOT NULL
        AND r.source_type = p_exclude_source_type
        AND (p_exclude_source_id IS NULL OR r.source_id = p_exclude_source_id)
      )
    GROUP BY r.product_id
  )
  SELECT
    i.product_id,
    COALESCE(q.on_hand, 0)::numeric,
    COALESCE(h.reserved, 0)::numeric,
    COALESCE(q.blocked, 0)::numeric,
    COALESCE(q.in_transit, 0)::numeric,
    (COALESCE(q.on_hand, 0) - COALESCE(h.reserved, 0))::numeric
  FROM ids i
  LEFT JOIN quants q ON q.product_id = i.product_id
  LEFT JOIN holds  h ON h.product_id = i.product_id;
END $function$;

REVOKE ALL ON FUNCTION public.resolve_stock_availability_batch(uuid[], uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_stock_availability_batch(uuid[], uuid, uuid, uuid, text, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_stock_availability_batch(uuid[], uuid, uuid, uuid, text, uuid) IS
  'ADR 0142: the single availability formula. Batch form; resolve_stock_availability is a thin wrapper over it.';

-- ---------------------------------------------------------------------
-- Single-product form becomes a wrapper — one formula, two shapes.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_stock_availability(
  p_product_id uuid,
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_warehouse_id uuid DEFAULT NULL::uuid,
  p_exclude_source_type text DEFAULT NULL::text,
  p_exclude_source_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(product_id uuid, on_hand numeric, reserved numeric,
              blocked numeric, in_transit numeric, available numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_product_id IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_AVAILABILITY_NO_PRODUCT: product is required';
  END IF;

  RETURN QUERY
  SELECT b.product_id, b.on_hand, b.reserved, b.blocked, b.in_transit, b.available
    FROM public.resolve_stock_availability_batch(
           ARRAY[p_product_id]::uuid[], p_business_id, p_branch_id,
           p_warehouse_id, p_exclude_source_type, p_exclude_source_id) b;
END $function$;

REVOKE ALL ON FUNCTION public.resolve_stock_availability(uuid, uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_stock_availability(uuid, uuid, uuid, uuid, text, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7b — the product list RPC reads the engine instead of warehouse_stock.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.list_products_with_branch_stock(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.list_products_with_branch_stock(
  p_org_id uuid,
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_include_variant_parents boolean DEFAULT false
)
RETURNS TABLE(id uuid, organization_id uuid, business_id uuid, type text, name text,
              description text, sku text, unit_price numeric, cost_price numeric,
              tax_rate numeric, tax_rate_id uuid, is_active boolean, image_url text,
              category_id uuid, track_inventory boolean, reorder_level numeric,
              min_order_quantity numeric, order_quantity_increment numeric,
              sales_account_id uuid, cogs_account_id uuid, inventory_account_id uuid,
              purchase_account_id uuid, on_hand numeric, reserved numeric,
              available numeric, branch_scope_label text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_branch_label text;
  v_ids uuid[];
BEGIN
  IF NOT public.user_has_business_access(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'access denied for business %', p_business_id USING ERRCODE = '42501';
  END IF;

  IF p_branch_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = p_branch_id AND b.business_id = p_business_id) THEN
      RAISE EXCEPTION 'branch % does not belong to business %', p_branch_id, p_business_id USING ERRCODE = '22023';
    END IF;
    SELECT b.name INTO v_branch_label FROM public.branches b WHERE b.id = p_branch_id;
    v_branch_label := COALESCE(v_branch_label, 'Branch');
  ELSE
    v_branch_label := 'All branches';
  END IF;

  SELECT array_agg(p.id)
    INTO v_ids
    FROM public.products p
   WHERE p.organization_id = p_org_id
     AND p.business_id = p_business_id
     AND p.is_active = true
     AND (p_include_variant_parents OR NOT COALESCE(p.is_variant_parent, false));

  RETURN QUERY
  WITH stock AS (
    SELECT a.product_id, a.on_hand, a.reserved, a.available
      FROM public.resolve_stock_availability_batch(
             COALESCE(v_ids, ARRAY[]::uuid[]), p_business_id, p_branch_id) a
  )
  SELECT
    p.id, p.organization_id, p.business_id, p.type::text, p.name, p.description, p.sku,
    p.unit_price, p.cost_price, p.tax_rate, p.tax_rate_id, p.is_active, p.image_url, p.category_id,
    p.track_inventory, p.reorder_level, p.min_order_quantity, p.order_quantity_increment,
    p.sales_account_id, p.cogs_account_id, p.inventory_account_id, p.purchase_account_id,
    COALESCE(s.on_hand, 0)::numeric,
    COALESCE(s.reserved, 0)::numeric,
    COALESCE(s.available, 0)::numeric,
    v_branch_label
  FROM public.products p
  LEFT JOIN stock s ON s.product_id = p.id
  WHERE p.id = ANY (COALESCE(v_ids, ARRAY[]::uuid[]))
  ORDER BY p.name;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_products_with_branch_stock(uuid, uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_products_with_branch_stock(uuid, uuid, uuid, boolean) TO authenticated, service_role;