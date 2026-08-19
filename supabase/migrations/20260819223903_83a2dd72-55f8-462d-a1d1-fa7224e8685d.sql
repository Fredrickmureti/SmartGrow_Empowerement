CREATE OR REPLACE FUNCTION public.report_inventory_aging_as_of(
  p_org       uuid,
  p_business  uuid,
  p_as_of     date DEFAULT NULL::date,
  p_branch    uuid DEFAULT NULL::uuid,
  p_warehouse uuid DEFAULT NULL::uuid,
  p_product   uuid DEFAULT NULL::uuid,
  p_category  uuid DEFAULT NULL::uuid,
  p_limit     integer DEFAULT 500,
  p_offset    integer DEFAULT 0
)
RETURNS TABLE(
  product_id        uuid,
  product_name      text,
  sku               text,
  category_id       uuid,
  warehouse_id      uuid,
  warehouse_name    text,
  branch_id         uuid,
  qty_0_30          numeric,
  value_0_30        numeric,
  qty_31_60         numeric,
  value_31_60       numeric,
  qty_61_90         numeric,
  value_61_90       numeric,
  qty_90_plus       numeric,
  value_90_plus     numeric,
  qty_on_hand       numeric,
  total_value       numeric,
  oldest_receipt_at timestamptz,
  layer_count       integer,
  total_rows        bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_as_of_date date        := COALESCE(p_as_of, current_date);
  v_as_of      timestamptz := (v_as_of_date + 1)::timestamptz;  -- exclusive
  v_limit      integer := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
  v_offset     integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_guard      boolean := NOT public._is_trusted_inventory_diag_context();
BEGIN
  IF v_guard THEN
    PERFORM public._assert_org_member(p_org);
    PERFORM public._assert_inventory_report_access(p_business, p_branch);
  END IF;

  RETURN QUERY
  WITH layer_state AS (
    SELECT
      cl.product_id,
      cl.warehouse_id,
      cl.unit_cost,
      cl.received_at,
      -- Age of the LAYER (not the product) at the as-of date.
      GREATEST((v_as_of_date - cl.received_at::date), 0) AS age_days,
      cl.qty_total - COALESCE(c.consumed, 0)             AS qty_as_of
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
      AND (NOT v_guard OR w.branch_id IS NULL
           OR public.can_access_branch(auth.uid(), w.branch_id))
  ),
  agg AS (
    SELECT
      ls.product_id,
      ls.warehouse_id,
      COALESCE(SUM(ls.qty_as_of) FILTER (WHERE ls.age_days <= 30), 0) AS qty_0_30,
      COALESCE(SUM(ls.qty_as_of * ls.unit_cost) FILTER (WHERE ls.age_days <= 30), 0) AS value_0_30,
      COALESCE(SUM(ls.qty_as_of) FILTER (WHERE ls.age_days > 30 AND ls.age_days <= 60), 0) AS qty_31_60,
      COALESCE(SUM(ls.qty_as_of * ls.unit_cost) FILTER (WHERE ls.age_days > 30 AND ls.age_days <= 60), 0) AS value_31_60,
      COALESCE(SUM(ls.qty_as_of) FILTER (WHERE ls.age_days > 60 AND ls.age_days <= 90), 0) AS qty_61_90,
      COALESCE(SUM(ls.qty_as_of * ls.unit_cost) FILTER (WHERE ls.age_days > 60 AND ls.age_days <= 90), 0) AS value_61_90,
      COALESCE(SUM(ls.qty_as_of) FILTER (WHERE ls.age_days > 90), 0) AS qty_90_plus,
      COALESCE(SUM(ls.qty_as_of * ls.unit_cost) FILTER (WHERE ls.age_days > 90), 0) AS value_90_plus,
      COALESCE(SUM(ls.qty_as_of), 0)                AS qty_on_hand,
      COALESCE(SUM(ls.qty_as_of * ls.unit_cost), 0) AS total_value,
      MIN(ls.received_at) FILTER (WHERE ls.qty_as_of > 0) AS oldest_receipt_at,
      COUNT(*) FILTER (WHERE ls.qty_as_of <> 0)::int      AS layer_count
    FROM layer_state ls
    GROUP BY ls.product_id, ls.warehouse_id
  )
  SELECT
    a.product_id,
    p.name::text,
    p.sku::text,
    p.category_id,
    a.warehouse_id,
    w.name::text,
    w.branch_id,
    ROUND(a.qty_0_30, 4),
    ROUND(a.value_0_30, 2),
    ROUND(a.qty_31_60, 4),
    ROUND(a.value_31_60, 2),
    ROUND(a.qty_61_90, 4),
    ROUND(a.value_61_90, 2),
    ROUND(a.qty_90_plus, 4),
    ROUND(a.value_90_plus, 2),
    ROUND(a.qty_on_hand, 4),
    ROUND(a.total_value, 2),
    a.oldest_receipt_at,
    a.layer_count,
    COUNT(*) OVER () AS total_rows
  FROM agg a
  JOIN public.products p ON p.id = a.product_id
  LEFT JOIN public.warehouses w ON w.id = a.warehouse_id
  WHERE a.qty_on_hand <> 0 OR a.total_value <> 0
  ORDER BY p.name, w.name NULLS FIRST, a.product_id, a.warehouse_id
  LIMIT v_limit OFFSET v_offset;
END;
$function$;

REVOKE ALL ON FUNCTION public.report_inventory_aging_as_of(uuid, uuid, date, uuid, uuid, uuid, uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_inventory_aging_as_of(uuid, uuid, date, uuid, uuid, uuid, uuid, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.report_inventory_aging_as_of(uuid, uuid, date, uuid, uuid, uuid, uuid, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_inventory_aging_as_of(uuid, uuid, date, uuid, uuid, uuid, uuid, integer, integer) TO service_role;