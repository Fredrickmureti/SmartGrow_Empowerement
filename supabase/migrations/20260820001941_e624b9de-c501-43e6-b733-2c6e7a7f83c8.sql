-- Phase 7.0 — close the trace-RPC boundary: no anonymous execution of
-- SECURITY DEFINER lot/serial trace functions.
REVOKE ALL ON FUNCTION public.trace_lot_genealogy(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trace_lot_genealogy(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.trace_lot_genealogy(uuid, uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.check_serial_position_drift(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_serial_position_drift(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.check_serial_position_drift(uuid) TO authenticated, service_role;

-- Phase 7.1 — the shared as-at layer valuation helper, with an OPTIONAL lot
-- grain. One valuation basis for valuation, aging, reconciliation, composition
-- and now lot traceability; no duplicated layer arithmetic anywhere.
CREATE OR REPLACE FUNCTION public._inventory_layer_valuation_as_of(
  p_org uuid,
  p_business uuid,
  p_as_of date DEFAULT NULL::date,
  p_branch uuid DEFAULT NULL::uuid,
  p_warehouse uuid DEFAULT NULL::uuid,
  p_product uuid DEFAULT NULL::uuid,
  p_category uuid DEFAULT NULL::uuid,
  p_by_lot boolean DEFAULT false,
  p_lot text DEFAULT NULL::text)
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
    MIN(ls.branch_id)                                        AS branch_id,
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
  GROUP BY ls.product_id, ls.warehouse_id, ls.lot_number;
END;
$function$;

REVOKE ALL ON FUNCTION public._inventory_layer_valuation_as_of(uuid, uuid, date, uuid, uuid, uuid, uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._inventory_layer_valuation_as_of(uuid, uuid, date, uuid, uuid, uuid, uuid, boolean, text) FROM anon;
GRANT EXECUTE ON FUNCTION public._inventory_layer_valuation_as_of(uuid, uuid, date, uuid, uuid, uuid, uuid, boolean, text) TO authenticated, service_role;

-- Phase 7.1 — lot / serial traceability report family: lot x product x
-- warehouse, valued on the shared layer basis, with expiry and control status.
CREATE OR REPLACE FUNCTION public.report_lot_traceability_as_of(
  p_org uuid,
  p_business uuid,
  p_as_of date DEFAULT NULL::date,
  p_branch uuid DEFAULT NULL::uuid,
  p_warehouse uuid DEFAULT NULL::uuid,
  p_product uuid DEFAULT NULL::uuid,
  p_category uuid DEFAULT NULL::uuid,
  p_lot text DEFAULT NULL::text,
  p_status text DEFAULT NULL::text,
  p_expiry_bucket text DEFAULT NULL::text,
  p_include_depleted boolean DEFAULT false,
  p_limit integer DEFAULT 500,
  p_offset integer DEFAULT 0)
 RETURNS TABLE(product_id uuid, product_name text, sku text, category_id uuid, warehouse_id uuid, warehouse_name text, branch_id uuid, lot_number text, lot_id uuid, supplier_name text, receipt_number text, manufacture_date date, expiry_date date, days_to_expiry integer, expiry_bucket text, lot_status text, layer_count integer, qty_received numeric, qty_consumed numeric, qty_on_hand numeric, avg_unit_cost numeric, total_value numeric, first_receipt_at timestamp with time zone, last_movement_at timestamp with time zone, total_rows bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_as_of  date    := COALESCE(p_as_of, current_date);
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  PERFORM public._assert_org_member(p_org);

  IF p_business IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_REPORT_BUSINESS_REQUIRED: a company must be selected'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._assert_inventory_report_access(p_business, p_branch);

  RETURN QUERY
  WITH agg AS (
    SELECT * FROM public._inventory_layer_valuation_as_of(
      p_org, p_business, v_as_of, p_branch, p_warehouse, p_product, p_category,
      true, p_lot)
  ),
  lot_master AS (
    SELECT sl.id, sl.product_id, sl.lot_number, sl.expiry_date,
           sl.manufacture_date, sl.is_active, sl.supplier_id, sl.goods_receipt_id
      FROM public.stock_lots sl
     WHERE sl.organization_id = p_org
       AND sl.business_id = p_business
  ),
  quarantined AS (
    SELECT DISTINCT lq.lot_id
      FROM public.lot_quarantine lq
     WHERE lq.organization_id = p_org
       AND lq.business_id = p_business
       AND lq.released_date IS NULL
       AND lq.quarantine_date::date <= v_as_of
  ),
  recalled AS (
    SELECT DISTINCT pri.lot_id
      FROM public.product_recall_items pri
      JOIN public.product_recalls pr ON pr.id = pri.recall_id
     WHERE pr.organization_id = p_org
       AND pr.business_id = p_business
       AND pr.closed_at IS NULL
       AND pr.recall_date <= v_as_of
  ),
  last_move AS (
    SELECT sm.product_id, sm.warehouse_id, NULLIF(sm.lot_number, '') AS lot_number,
           MAX(sm.movement_date) AS last_movement_at
      FROM public.stock_movements sm
     WHERE sm.organization_id = p_org
       AND sm.business_id = p_business
       AND sm.movement_date < (v_as_of + 1)::timestamptz
       AND sm.lot_number IS NOT NULL
     GROUP BY 1, 2, 3
  ),
  rows_out AS (
    SELECT
      a.product_id,
      p.name::text AS product_name,
      p.sku::text  AS sku,
      p.category_id,
      a.warehouse_id,
      w.name::text AS warehouse_name,
      a.branch_id,
      a.lot_number,
      lm.id AS lot_id,
      sup.name::text AS supplier_name,
      gr.receipt_number::text AS receipt_number,
      lm.manufacture_date,
      lm.expiry_date,
      CASE WHEN lm.expiry_date IS NULL THEN NULL
           ELSE (lm.expiry_date - v_as_of)::int END AS days_to_expiry,
      CASE
        WHEN lm.expiry_date IS NULL              THEN 'none'
        WHEN lm.expiry_date < v_as_of            THEN 'expired'
        WHEN lm.expiry_date - v_as_of <= 30      THEN '0_30'
        WHEN lm.expiry_date - v_as_of <= 60      THEN '31_60'
        WHEN lm.expiry_date - v_as_of <= 90      THEN '61_90'
        ELSE '90_plus'
      END AS expiry_bucket,
      CASE
        WHEN r.lot_id IS NOT NULL                       THEN 'recalled'
        WHEN q.lot_id IS NOT NULL                       THEN 'quarantined'
        WHEN lm.expiry_date IS NOT NULL
             AND lm.expiry_date < v_as_of               THEN 'expired'
        WHEN lm.id IS NULL                              THEN 'untracked'
        WHEN COALESCE(lm.is_active, true) = false        THEN 'inactive'
        ELSE 'active'
      END AS lot_status,
      a.layer_count,
      ROUND(a.qty_received, 4) AS qty_received,
      ROUND(a.qty_consumed, 4) AS qty_consumed,
      ROUND(a.qty_on_hand, 4)  AS qty_on_hand,
      CASE WHEN a.qty_on_hand <> 0
           THEN ROUND(a.total_value / a.qty_on_hand, 4)
           ELSE 0 END AS avg_unit_cost,
      ROUND(a.total_value, 2) AS total_value,
      a.oldest_receipt_at AS first_receipt_at,
      mv.last_movement_at
    FROM agg a
    JOIN public.products p ON p.id = a.product_id
    LEFT JOIN public.warehouses w ON w.id = a.warehouse_id
    LEFT JOIN lot_master lm
           ON lm.product_id = a.product_id
          AND lm.lot_number IS NOT DISTINCT FROM a.lot_number
    LEFT JOIN quarantined q ON q.lot_id = lm.id
    LEFT JOIN recalled    r ON r.lot_id = lm.id
    LEFT JOIN public.contacts sup ON sup.id = lm.supplier_id
    LEFT JOIN public.goods_receipts gr ON gr.id = lm.goods_receipt_id
    LEFT JOIN last_move mv
           ON mv.product_id = a.product_id
          AND mv.warehouse_id IS NOT DISTINCT FROM a.warehouse_id
          AND mv.lot_number IS NOT DISTINCT FROM a.lot_number
    -- Depleted lots are hidden by default so the value column ties to the
    -- Inventory Valuation total; traceability can opt them back in.
    WHERE (p_include_depleted OR a.qty_on_hand <> 0 OR a.total_value <> 0)
  )
  SELECT ro.*, COUNT(*) OVER () AS total_rows
  FROM rows_out ro
  WHERE (p_status IS NULL OR ro.lot_status = p_status)
    AND (p_expiry_bucket IS NULL OR ro.expiry_bucket = p_expiry_bucket)
  ORDER BY
    CASE ro.expiry_bucket
      WHEN 'expired' THEN 0 WHEN '0_30' THEN 1 WHEN '31_60' THEN 2
      WHEN '61_90' THEN 3 WHEN '90_plus' THEN 4 ELSE 5 END,
    ro.expiry_date NULLS LAST,
    ro.product_name,
    ro.lot_number NULLS LAST
  LIMIT v_limit OFFSET v_offset;
END;
$function$;

REVOKE ALL ON FUNCTION public.report_lot_traceability_as_of(uuid, uuid, date, uuid, uuid, uuid, uuid, text, text, text, boolean, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_lot_traceability_as_of(uuid, uuid, date, uuid, uuid, uuid, uuid, text, text, text, boolean, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.report_lot_traceability_as_of(uuid, uuid, date, uuid, uuid, uuid, uuid, text, text, text, boolean, integer, integer) TO authenticated, service_role;