-- ============================================================================
-- Phase 8: Stock Adjustments / Stock Transfers reports become server-owned.
--
-- Defects being closed (all observed in src/pages/reports/*):
--   1. cost impact was Σ(quantity_adjustment × unit_cost) computed in the
--      BROWSER from line snapshots, not from the posted movement ledger.
--   2. no LIMIT — PostgREST silently truncated at 1000 rows, so the KPI
--      totals under-reported on any busy company.
--   3. business scope was optional, so with no active company the page read
--      the whole organization.
-- ============================================================================

-- Shared "company is mandatory" raiser, so both reports fail identically
-- instead of quietly widening to the whole organization. Defined first so
-- the report bodies resolve it at creation time.
CREATE OR REPLACE FUNCTION public._raise_business_required()
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RAISE EXCEPTION 'INVENTORY_REPORT_BUSINESS_REQUIRED: a company is required'
    USING ERRCODE = '22023';
END;
$$;

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
  cost_basis              text
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
  )
  SELECT
    a.id,
    a.adjustment_number,
    a.adjustment_date,
    a.reason,
    a.status,
    a.warehouse_id,
    a.branch_id,
    a.approved_at,
    a.reverses_adjustment_id,
    COALESCE(l.line_count, 0),
    COALESCE(l.abs_qty, 0),
    CASE
      WHEN g.movement_count > 0 THEN g.ledger_cost
      ELSE COALESCE(l.line_cost, 0)
    END,
    CASE
      WHEN g.movement_count > 0 THEN 'movement_ledger'
      WHEN COALESCE(l.line_count, 0) = 0 THEN 'none'
      ELSE 'estimated_from_lines'
    END
  FROM adj a
  LEFT JOIN lines  l ON l.adjustment_id = a.id
  LEFT JOIN ledger g ON g.adjustment_id = a.id
  ORDER BY a.adjustment_date DESC, a.adjustment_number DESC
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
  variance              numeric
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
  )
  SELECT
    t.id,
    t.transfer_number,
    t.transfer_date,
    t.status,
    t.from_branch_id,
    t.to_branch_id,
    t.from_warehouse_id,
    t.to_warehouse_id,
    fw.name,
    tw.name,
    t.expected_arrival_date,
    t.actual_arrival_date,
    t.completed_at,
    COALESCE(l.line_count, 0),
    COALESCE(l.qty_requested, 0),
    COALESCE(l.qty_sent, 0),
    COALESCE(l.qty_received, 0),
    COALESCE(l.qty_sent, 0) - COALESCE(l.qty_received, 0)
  FROM tr t
  LEFT JOIN lines l ON l.transfer_id = t.id
  LEFT JOIN public.warehouses fw ON fw.id = t.from_warehouse_id
  LEFT JOIN public.warehouses tw ON tw.id = t.to_warehouse_id
  ORDER BY t.transfer_date DESC, t.transfer_number DESC
  LIMIT GREATEST(COALESCE(_limit, 1000), 0)
  OFFSET GREATEST(COALESCE(_offset, 0), 0);
$$;

REVOKE ALL ON FUNCTION public.report_stock_adjustments(uuid, uuid, uuid, date, date, text, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.report_stock_transfers(uuid, uuid, uuid, date, date, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._raise_business_required() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_stock_adjustments(uuid, uuid, uuid, date, date, text, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.report_stock_transfers(uuid, uuid, uuid, date, date, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._raise_business_required() TO authenticated, service_role;

COMMENT ON FUNCTION public.report_stock_adjustments(uuid, uuid, uuid, date, date, text, text, integer, integer) IS
  'Phase 8: server-owned stock adjustments report. Cost impact comes from the posted movement ledger; line snapshots are used only when nothing has posted and are flagged via cost_basis.';
COMMENT ON FUNCTION public.report_stock_transfers(uuid, uuid, uuid, date, date, text, integer, integer) IS
  'Phase 8: server-owned stock transfers report. Quantity aggregates and send/receive variance are computed server-side; company scope is mandatory.';