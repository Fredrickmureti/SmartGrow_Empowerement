-- ADR 0142 Phase 1b: collapse the fourth availability formula.
-- resolve_stock_availability gains an optional reservation-source exclusion so
-- POS can ignore a register's own hold without owning a second formula.

DROP FUNCTION IF EXISTS public.resolve_stock_availability(uuid, uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.resolve_stock_availability(
  p_product_id uuid,
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_warehouse_id uuid DEFAULT NULL::uuid,
  p_exclude_source_type text DEFAULT NULL::text,
  p_exclude_source_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(product_id uuid, on_hand numeric, reserved numeric, blocked numeric, in_transit numeric, available numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_on_hand    numeric := 0;
  v_blocked    numeric := 0;
  v_transit    numeric := 0;
  v_reserved   numeric := 0;
BEGIN
  IF p_product_id IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_AVAILABILITY_NO_PRODUCT: product is required';
  END IF;
  IF p_business_id IS NULL AND p_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_AVAILABILITY_NO_SCOPE: a business or a warehouse is required';
  END IF;

  SELECT
    COALESCE(SUM(q.quantity) FILTER (
      WHERE l.location_type = 'internal'
        AND COALESCE(l.is_blocked, false) = false
        AND COALESCE(w.is_in_transit, false) = false
    ), 0),
    COALESCE(SUM(q.quantity) FILTER (
      WHERE l.location_type = 'quarantine' OR COALESCE(l.is_blocked, false)
    ), 0),
    COALESCE(SUM(q.quantity) FILTER (
      WHERE l.location_type = 'transit' OR COALESCE(w.is_in_transit, false)
    ), 0)
  INTO v_on_hand, v_blocked, v_transit
  FROM public.stock_quants q
  JOIN public.stock_locations l ON l.id = q.location_id
  LEFT JOIN public.warehouses w ON w.id = l.warehouse_id
  WHERE q.product_id = p_product_id
    AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id)
    AND (p_business_id  IS NULL OR q.business_id  = p_business_id)
    AND (p_branch_id    IS NULL OR q.branch_id    = p_branch_id);

  SELECT COALESCE(SUM(r.quantity), 0)
    INTO v_reserved
    FROM public.stock_reservations r
    LEFT JOIN public.warehouses w ON w.id = r.warehouse_id
   WHERE r.product_id = p_product_id
     AND public.stock_reservation_is_open(r.status, r.expires_at)
     AND (p_warehouse_id IS NULL OR r.warehouse_id = p_warehouse_id)
     AND (p_business_id  IS NULL OR r.business_id  = p_business_id)
     AND (p_branch_id    IS NULL OR r.branch_id    = p_branch_id)
     AND COALESCE(w.is_in_transit, false) = false
     -- caller-scoped exclusion: a source ignoring its own hold
     AND NOT (
       p_exclude_source_type IS NOT NULL
       AND r.source_type = p_exclude_source_type
       AND (p_exclude_source_id IS NULL OR r.source_id = p_exclude_source_id)
     );

  RETURN QUERY SELECT p_product_id, v_on_hand, v_reserved, v_blocked, v_transit,
                      (v_on_hand - v_reserved);
END $function$;

-- POS register availability becomes a warehouse-resolution wrapper only.
CREATE OR REPLACE FUNCTION public.get_available_pos_stock_for_register(
  p_product_id uuid,
  p_register_id uuid,
  p_exclude_self boolean DEFAULT true
)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_register RECORD;
  v_warehouse_id uuid;
  v numeric;
BEGIN
  -- ADR 0142: thin wrapper. Do not reimplement availability here.
  SELECT business_id, branch_id INTO v_register
    FROM public.pos_registers WHERE id = p_register_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Register % not found', p_register_id;
  END IF;

  SELECT s.warehouse_id INTO v_warehouse_id
    FROM public.pos_shifts s
   WHERE s.register_id = p_register_id AND s.status = 'open'
   ORDER BY s.opened_at DESC LIMIT 1;

  IF v_warehouse_id IS NULL THEN
    SELECT id INTO v_warehouse_id
      FROM public.warehouses
     WHERE business_id = v_register.business_id
       AND branch_id   = v_register.branch_id
       AND is_active   = true
     ORDER BY is_default DESC LIMIT 1;
  END IF;

  IF v_warehouse_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT a.available INTO v
    FROM public.resolve_stock_availability(
           p_product_id,
           v_register.business_id,
           v_register.branch_id,
           v_warehouse_id,
           CASE WHEN p_exclude_self THEN 'pos' ELSE NULL END,
           CASE WHEN p_exclude_self THEN p_register_id ELSE NULL END
         ) a;

  RETURN GREATEST(0, COALESCE(v, 0));
END;
$function$;

GRANT EXECUTE ON FUNCTION public.resolve_stock_availability(uuid, uuid, uuid, uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_stock_availability(uuid, uuid, uuid, uuid, text, uuid) TO service_role;