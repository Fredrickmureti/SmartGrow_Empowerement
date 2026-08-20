CREATE OR REPLACE FUNCTION public._inventory_layer_valuation_as_of(p_org uuid, p_business uuid, p_as_of date DEFAULT NULL::date, p_branch uuid DEFAULT NULL::uuid, p_warehouse uuid DEFAULT NULL::uuid, p_product uuid DEFAULT NULL::uuid, p_category uuid DEFAULT NULL::uuid, p_by_lot boolean DEFAULT false, p_lot text DEFAULT NULL::text)
 RETURNS TABLE(product_id uuid, warehouse_id uuid, branch_id uuid, lot_number text, layer_count integer, qty_received numeric, qty_consumed numeric, qty_on_hand numeric, total_value numeric, oldest_receipt_at timestamp with time zone, latest_receipt_at timestamp with time zone, zero_cost_layers integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_as_of timestamptz := (COALESCE(p_as_of, current_date) + 1)::timestamptz; -- exclusive
  v_guard boolean := NOT public._is_trusted_inventory_diag_context();
BEGIN
  -- Authorization is asserted here too: the helper is self-contained so no
  -- caller can accidentally read across a tenant / business / branch line.
  PERFORM public._assert_org_member(p_org);
  PERFORM public._assert_inventory_report_access(p_business, p_branch);

  RETURN QUERY
  WITH layer_state AS (
    SELECT
      cl.product_id,
      cl.warehouse_id,
      w.branch_id,
      CASE WHEN p_by_lot THEN NULLIF(cl.lot_number, '') ELSE NULL END AS lot_number,
      cl.unit_cost,
      cl.received_at,
      cl.qty_total,
      COALESCE(c.consumed, 0) AS consumed,
      -- Quantity still on hand AS AT the as-of date: received quantity less
      -- everything consumed at or before that date. Never derived from the
      -- live qty_remaining, which only describes "now".
      cl.qty_total - COALESCE(c.consumed, 0) AS qty_as_of
    FROM public.cost_layers cl
    LEFT JOIN public.warehouses w ON w.id = cl.warehouse_id
    LEFT JOIN (
      SELECT clc.layer_id, SUM(clc.qty_consumed) AS consumed
        FROM public.cost_layer_consumptions clc
       WHERE clc.consumed_at < v_as_of
       GROUP BY clc.layer_id
    ) c ON c.layer_id = cl.id
    JOIN public.products p ON p.id = cl.product_id
    WHERE cl.organization_id = p_org
      AND cl.business_id = p_business
      AND cl.received_at < v_as_of
      AND (p_branch    IS NULL OR w.branch_id = p_branch)
      AND (p_warehouse IS NULL OR cl.warehouse_id = p_warehouse)
      AND (p_product   IS NULL OR cl.product_id = p_product)
      AND (p_category  IS NULL OR p.category_id = p_category)
      AND (p_lot       IS NULL OR cl.lot_number = p_lot)
      AND (NOT v_guard OR w.branch_id IS NULL
           OR public.can_access_branch(auth.uid(), w.branch_id))
  )
  SELECT
    ls.product_id,
    ls.warehouse_id,
    -- branch_id is functionally dependent on warehouse_id, so it is a grouping
    -- key rather than an aggregate. Postgres has no min(uuid).
    ls.branch_id,
    ls.lot_number,
    COUNT(*) FILTER (WHERE ls.qty_as_of <> 0)::int           AS layer_count,
    COALESCE(SUM(ls.qty_total), 0)                           AS qty_received,
    COALESCE(SUM(ls.consumed), 0)                            AS qty_consumed,
    COALESCE(SUM(ls.qty_as_of), 0)                           AS qty_on_hand,
    COALESCE(SUM(ls.qty_as_of * ls.unit_cost), 0)            AS total_value,
    MIN(ls.received_at) FILTER (WHERE ls.qty_as_of > 0)      AS oldest_receipt_at,
    MAX(ls.received_at)                                      AS latest_receipt_at,
    COUNT(*) FILTER (WHERE ls.qty_as_of <> 0
                       AND COALESCE(ls.unit_cost, 0) = 0)::int AS zero_cost_layers
  FROM layer_state ls
  GROUP BY ls.product_id, ls.warehouse_id, ls.branch_id, ls.lot_number;
END;
$function$;

REVOKE ALL ON FUNCTION public._inventory_layer_valuation_as_of(uuid,uuid,date,uuid,uuid,uuid,uuid,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._inventory_layer_valuation_as_of(uuid,uuid,date,uuid,uuid,uuid,uuid,boolean,text) TO authenticated, service_role;