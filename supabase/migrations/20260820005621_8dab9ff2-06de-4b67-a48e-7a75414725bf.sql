-- Both Phase 8 reports must page explicitly (like the valuation / ledger
-- RPCs) rather than truncating. Returning the unpaged match count with each
-- row is how the client knows there is more to fetch.
DROP FUNCTION IF EXISTS public.report_stock_adjustments(uuid, uuid, uuid, date, date, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.report_stock_transfers(uuid, uuid, uuid, date, date, text, integer, integer);

CREATE OR REPLACE FUNCTION public.report_stock_adjustments(
  _organization_id uuid,
  _business_id     uuid,
  _branch_id       uuid DEFAULT NULL,
  _from_date       date DEFAULT NULL,
  _to_date         date DEFAULT NULL,
  _status          text DEFAULT NULL,
  _reason          text DEFAULT NULL,
  _limit           integer DEFAULT 1000,
  _offset          integer DEFAULT 0
)
RETURNS TABLE (
  adjustment_id           uuid,
  adjustment_number       text,
  adjustment_date         timestamptz,
  reason                  text,
  status                  text,
  warehouse_id            uuid,
  branch_id               uuid,
  approved_at             timestamptz,
  reverses_adjustment_id  uuid,
  line_count              integer,
  abs_qty                 numeric,
  cost_impact             numeric,
  cost_basis              text,
  total_rows              bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH guard AS (
    SELECT public._assert_inventory_report_access(
      COALESCE(_business_id, public._raise_business_required()),
      _branch_id
    )
  ),
  adj AS (
    SELECT a.*
    FROM public.stock_adjustments a, guard
    WHERE a.organization_id = _organization_id
      AND a.business_id = _business_id
      AND (_branch_id IS NULL OR a.branch_id = _branch_id OR a.branch_id IS NULL)
      AND (_from_date IS NULL OR a.adjustment_date >= _from_date::timestamptz)
      AND (_to_date   IS NULL OR a.adjustment_date < (_to_date + 1)::timestamptz)
      AND (_status IS NULL OR a.status = _status)
      AND (_reason IS NULL OR a.reason = _reason)
  ),
  lines AS (
    SELECT i.adjustment_id,
           count(*)::int                                     AS line_count,
           COALESCE(sum(abs(i.quantity_adjustment)), 0)       AS abs_qty,
           COALESCE(sum(i.quantity_adjustment * COALESCE(i.unit_cost, 0)), 0) AS line_cost
    FROM public.stock_adjustment_items i
    WHERE i.adjustment_id IN (SELECT id FROM adj)
    GROUP BY i.adjustment_id
  ),
  -- The immutable movement ledger is the canonical cost fact for anything
  -- that actually posted. Line snapshots are only an estimate of intent.
  ledger AS (
    SELECT m.reference_id AS adjustment_id,
           COALESCE(sum(m.quantity * COALESCE(m.unit_cost, 0)), 0) AS ledger_cost,
           count(*) AS movement_count
    FROM public.stock_movements m
    WHERE m.reference_type = 'stock_adjustment'
      AND m.reference_id IN (SELECT id FROM adj)
    GROUP BY m.reference_id
  ),
  joined AS (
    SELECT
      a.id                                  AS adjustment_id,
      a.adjustment_number,
      a.adjustment_date,
      a.reason,
      a.status,
      a.warehouse_id,
      a.branch_id,
      a.approved_at,
      a.reverses_adjustment_id,
      COALESCE(l.line_count, 0)             AS line_count,
      COALESCE(l.abs_qty, 0)                AS abs_qty,
      CASE
        WHEN g.movement_count > 0 THEN g.ledger_cost
        ELSE COALESCE(l.line_cost, 0)
      END                                   AS cost_impact,
      CASE
        WHEN g.movement_count > 0 THEN 'movement_ledger'
        WHEN COALESCE(l.line_count, 0) = 0 THEN 'none'
        ELSE 'estimated_from_lines'
      END                                   AS cost_basis,
      count(*) OVER ()                      AS total_rows
    FROM adj a
    LEFT JOIN lines  l ON l.adjustment_id = a.id
    LEFT JOIN ledger g ON g.adjustment_id = a.id
  )
  SELECT * FROM joined
  ORDER BY adjustment_date DESC, adjustment_number DESC
  LIMIT GREATEST(COALESCE(_limit, 1000), 0)
  OFFSET GREATEST(COALESCE(_offset, 0), 0);
$$;

CREATE OR REPLACE FUNCTION public.report_stock_transfers(
  _organization_id uuid,
  _business_id     uuid,
  _branch_id       uuid DEFAULT NULL,
  _from_date       date DEFAULT NULL,
  _to_date         date DEFAULT NULL,
  _status          text DEFAULT NULL,
  _limit           integer DEFAULT 1000,
  _offset          integer DEFAULT 0
)
RETURNS TABLE (
  transfer_id           uuid,
  transfer_number       text,
  transfer_date         timestamptz,
  status                text,
  from_branch_id        uuid,
  to_branch_id          uuid,
  from_warehouse_id     uuid,
  to_warehouse_id       uuid,
  from_warehouse_name   text,
  to_warehouse_name     text,
  expected_arrival_date timestamptz,
  actual_arrival_date   timestamptz,
  completed_at          timestamptz,
  line_count            integer,
  qty_requested         numeric,
  qty_sent              numeric,
  qty_received          numeric,
  variance              numeric,
  total_rows            bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH guard AS (
    SELECT public._assert_inventory_report_access(
      COALESCE(_business_id, public._raise_business_required()),
      _branch_id
    )
  ),
  tr AS (
    SELECT t.*
    FROM public.stock_transfers t, guard
    WHERE t.organization_id = _organization_id
      AND t.business_id = _business_id
      -- A branch cares about both its outbound and its inbound transfers.
      AND (_branch_id IS NULL
           OR t.from_branch_id = _branch_id
           OR t.to_branch_id = _branch_id)
      AND (_from_date IS NULL OR t.transfer_date >= _from_date::timestamptz)
      AND (_to_date   IS NULL OR t.transfer_date < (_to_date + 1)::timestamptz)
      AND (_status IS NULL OR t.status = _status)
  ),
  lines AS (
    SELECT i.transfer_id,
           count(*)::int                          AS line_count,
           COALESCE(sum(i.quantity_requested), 0)  AS qty_requested,
           COALESCE(sum(i.quantity_sent), 0)       AS qty_sent,
           COALESCE(sum(i.quantity_received), 0)   AS qty_received
    FROM public.stock_transfer_items i
    WHERE i.transfer_id IN (SELECT id FROM tr)
    GROUP BY i.transfer_id
  ),
  joined AS (
    SELECT
      t.id                                     AS transfer_id,
      t.transfer_number,
      t.transfer_date,
      t.status,
      t.from_branch_id,
      t.to_branch_id,
      t.from_warehouse_id,
      t.to_warehouse_id,
      fw.name                                  AS from_warehouse_name,
      tw.name                                  AS to_warehouse_name,
      t.expected_arrival_date,
      t.actual_arrival_date,
      t.completed_at,
      COALESCE(l.line_count, 0)                AS line_count,
      COALESCE(l.qty_requested, 0)             AS qty_requested,
      COALESCE(l.qty_sent, 0)                  AS qty_sent,
      COALESCE(l.qty_received, 0)              AS qty_received,
      COALESCE(l.qty_sent, 0) - COALESCE(l.qty_received, 0) AS variance,
      count(*) OVER ()                         AS total_rows
    FROM tr t
    LEFT JOIN lines l ON l.transfer_id = t.id
    LEFT JOIN public.warehouses fw ON fw.id = t.from_warehouse_id
    LEFT JOIN public.warehouses tw ON tw.id = t.to_warehouse_id
  )
  SELECT * FROM joined
  ORDER BY transfer_date DESC, transfer_number DESC
  LIMIT GREATEST(COALESCE(_limit, 1000), 0)
  OFFSET GREATEST(COALESCE(_offset, 0), 0);
$$;

REVOKE ALL ON FUNCTION public.report_stock_adjustments(uuid, uuid, uuid, date, date, text, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.report_stock_transfers(uuid, uuid, uuid, date, date, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_stock_adjustments(uuid, uuid, uuid, date, date, text, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.report_stock_transfers(uuid, uuid, uuid, date, date, text, integer, integer) TO authenticated, service_role;