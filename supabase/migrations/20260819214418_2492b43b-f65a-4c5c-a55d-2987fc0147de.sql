-- =====================================================================
-- Phase 2 — inventory reporting server foundation
-- Plan: .lovable/plan.md  (Phase 2 — Server reporting foundation)
--
-- Two authoritative, authorization-enforcing reporting RPCs over the
-- ledgers that already exist:
--   * report_stock_ledger()               — QUANTITY ledger (stock_movements)
--   * report_inventory_valuation_as_of()  — VALUE ledger (cost_layers +
--                                           cost_layer_consumptions)
--
-- Design rules:
--   * Business is an authorization boundary (never a caller-supplied filter).
--   * Branch is enforced: an explicit p_branch must be accessible, and when
--     no branch is given, rows are limited to accessible branches.
--   * Movement direction comes from the single server-side authority
--     public.stock_movement_signed_quantity(), never from re-derived signs.
--   * As-of valuation is reconstructed from layer receipts and consumptions
--     at/-before the as-of date, so a historical valuation is reproducible.
--   * Every row carries total_rows so callers page explicitly instead of
--     silently truncating at PostgREST's 1000-row cap.
-- =====================================================================

CREATE OR REPLACE FUNCTION public._assert_inventory_report_access(
  _business_id uuid,
  _branch_id uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF public._is_trusted_inventory_diag_context() THEN
    RETURN;
  END IF;
  PERFORM public._assert_inventory_diag_business(_business_id);
  IF _branch_id IS NOT NULL AND NOT public.can_access_branch(auth.uid(), _branch_id) THEN
    RAISE EXCEPTION 'INVENTORY_REPORT_FORBIDDEN: no access to branch %', _branch_id
      USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._assert_inventory_report_access(uuid, uuid) FROM PUBLIC, anon;

-- ------------------------------------------------------- quantity ledger
CREATE OR REPLACE FUNCTION public.report_stock_ledger(
  p_org       uuid,
  p_business  uuid,
  p_date_from date,
  p_date_to   date,
  p_branch    uuid DEFAULT NULL::uuid,
  p_warehouse uuid DEFAULT NULL::uuid,
  p_product   uuid DEFAULT NULL::uuid,
  p_category  uuid DEFAULT NULL::uuid,
  p_limit     integer DEFAULT 500,
  p_offset    integer DEFAULT 0
)
RETURNS TABLE(
  product_id     uuid,
  product_name   text,
  sku            text,
  category_id    uuid,
  warehouse_id   uuid,
  warehouse_name text,
  branch_id      uuid,
  opening_qty    numeric,
  qty_in         numeric,
  qty_out        numeric,
  closing_qty    numeric,
  movement_count integer,
  total_rows     bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_from   timestamptz := p_date_from::timestamptz;
  v_to     timestamptz := (p_date_to + 1)::timestamptz;   -- exclusive upper bound
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_guard  boolean := NOT public._is_trusted_inventory_diag_context();
BEGIN
  PERFORM public._assert_org_member(p_org);
  PERFORM public._assert_inventory_report_access(p_business, p_branch);

  IF p_date_from IS NULL OR p_date_to IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_REPORT_PERIOD_REQUIRED: p_date_from and p_date_to are required'
      USING ERRCODE = '22023';
  END IF;
  IF p_date_to < p_date_from THEN
    RAISE EXCEPTION 'INVENTORY_REPORT_PERIOD_INVALID: p_date_to precedes p_date_from'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH scoped AS (
    SELECT
      sm.product_id,
      sm.warehouse_id,
      sm.branch_id,
      sm.movement_date,
      public.stock_movement_signed_quantity(sm.movement_type, sm.quantity) AS signed_qty
    FROM public.stock_movements sm
    JOIN public.products p ON p.id = sm.product_id
    WHERE sm.organization_id = p_org
      AND sm.business_id = p_business
      AND sm.movement_date < v_to
      AND (p_branch    IS NULL OR sm.branch_id = p_branch)
      AND (p_warehouse IS NULL OR sm.warehouse_id = p_warehouse)
      AND (p_product   IS NULL OR sm.product_id = p_product)
      AND (p_category  IS NULL OR p.category_id = p_category)
      AND (NOT v_guard OR sm.branch_id IS NULL
           OR public.can_access_branch(auth.uid(), sm.branch_id))
  ),
  agg AS (
    SELECT
      s.product_id,
      s.warehouse_id,
      MIN(s.branch_id) AS branch_id,
      COALESCE(SUM(s.signed_qty) FILTER (WHERE s.movement_date < v_from), 0) AS opening_qty,
      COALESCE(SUM(s.signed_qty) FILTER (WHERE s.movement_date >= v_from
                                           AND s.signed_qty > 0), 0)        AS qty_in,
      COALESCE(SUM(s.signed_qty) FILTER (WHERE s.movement_date >= v_from
                                           AND s.signed_qty < 0), 0)        AS qty_out,
      COALESCE(SUM(s.signed_qty), 0)                                        AS closing_qty,
      COUNT(*) FILTER (WHERE s.movement_date >= v_from)::int                AS movement_count
    FROM scoped s
    GROUP BY s.product_id, s.warehouse_id
  )
  SELECT
    a.product_id,
    p.name::text,
    p.sku::text,
    p.category_id,
    a.warehouse_id,
    w.name::text,
    a.branch_id,
    ROUND(a.opening_qty, 4),
    ROUND(a.qty_in, 4),
    ROUND(a.qty_out, 4),
    ROUND(a.closing_qty, 4),
    a.movement_count,
    COUNT(*) OVER () AS total_rows
  FROM agg a
  JOIN public.products p ON p.id = a.product_id
  LEFT JOIN public.warehouses w ON w.id = a.warehouse_id
  -- A row with no opening, no movement and no closing carries no information.
  WHERE a.opening_qty <> 0 OR a.closing_qty <> 0 OR a.movement_count > 0
  ORDER BY p.name, w.name NULLS FIRST, a.product_id, a.warehouse_id
  LIMIT v_limit OFFSET v_offset;
END;
$function$;

REVOKE ALL ON FUNCTION public.report_stock_ledger(uuid, uuid, date, date, uuid, uuid, uuid, uuid, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.report_stock_ledger(uuid, uuid, date, date, uuid, uuid, uuid, uuid, integer, integer)
  TO authenticated, service_role;

-- ---------------------------------------------------------- value ledger
CREATE OR REPLACE FUNCTION public.report_inventory_valuation_as_of(
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
  layer_count       integer,
  qty_on_hand       numeric,
  avg_unit_cost     numeric,
  total_value       numeric,
  oldest_receipt_at timestamptz,
  total_rows        bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_as_of  timestamptz := (COALESCE(p_as_of, current_date) + 1)::timestamptz; -- exclusive
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_guard  boolean := NOT public._is_trusted_inventory_diag_context();
BEGIN
  PERFORM public._assert_org_member(p_org);
  PERFORM public._assert_inventory_report_access(p_business, p_branch);

  RETURN QUERY
  WITH layer_state AS (
    SELECT
      cl.product_id,
      cl.warehouse_id,
      w.branch_id,
      cl.unit_cost,
      cl.received_at,
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
      AND (NOT v_guard OR w.branch_id IS NULL
           OR public.can_access_branch(auth.uid(), w.branch_id))
  ),
  agg AS (
    SELECT
      ls.product_id,
      ls.warehouse_id,
      MIN(ls.branch_id) AS branch_id,
      COUNT(*) FILTER (WHERE ls.qty_as_of <> 0)::int AS layer_count,
      COALESCE(SUM(ls.qty_as_of), 0)                 AS qty_on_hand,
      COALESCE(SUM(ls.qty_as_of * ls.unit_cost), 0)  AS total_value,
      MIN(ls.received_at) FILTER (WHERE ls.qty_as_of > 0) AS oldest_receipt_at
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
    a.branch_id,
    a.layer_count,
    ROUND(a.qty_on_hand, 4),
    CASE WHEN a.qty_on_hand <> 0
         THEN ROUND(a.total_value / a.qty_on_hand, 4)
         ELSE 0 END,
    ROUND(a.total_value, 2),
    a.oldest_receipt_at,
    COUNT(*) OVER () AS total_rows
  FROM agg a
  JOIN public.products p ON p.id = a.product_id
  LEFT JOIN public.warehouses w ON w.id = a.warehouse_id
  WHERE a.qty_on_hand <> 0 OR a.total_value <> 0
  ORDER BY p.name, w.name NULLS FIRST, a.product_id, a.warehouse_id
  LIMIT v_limit OFFSET v_offset;
END;
$function$;

REVOKE ALL ON FUNCTION public.report_inventory_valuation_as_of(uuid, uuid, date, uuid, uuid, uuid, uuid, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.report_inventory_valuation_as_of(uuid, uuid, date, uuid, uuid, uuid, uuid, integer, integer)
  TO authenticated, service_role;