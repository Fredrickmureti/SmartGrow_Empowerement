-- =====================================================================
-- Phase 6 — Inventory <-> GL reconciliation onto the authoritative
-- cost-layer valuation basis.
--
-- Findings addressed (see .lovable/plan.md):
--   1. Two valuation sources of truth: report_inventory_valuation_as_of
--      valued stock from cost_layers/cost_layer_consumptions while
--      reconcile_inventory_subledger_to_gl valued it from
--      warehouse_stock.average_cost -> "drift" was not attributable.
--   2. The reconciliation had no true as-of: the subledger side read the
--      LIVE snapshot while the GL side summed posted lines <= p_as_of.
--
-- Fix: one internal helper, _inventory_layer_valuation_as_of(), owns the
-- layer arithmetic. Both the valuation report and the reconciliation read
-- it, so they cannot drift apart again.
-- =====================================================================

-- --------------------------------------------- shared layer arithmetic
CREATE OR REPLACE FUNCTION public._inventory_layer_valuation_as_of(
  p_org       uuid,
  p_business  uuid,
  p_as_of     date DEFAULT NULL::date,
  p_branch    uuid DEFAULT NULL::uuid,
  p_warehouse uuid DEFAULT NULL::uuid,
  p_product   uuid DEFAULT NULL::uuid,
  p_category  uuid DEFAULT NULL::uuid
)
RETURNS TABLE(
  product_id        uuid,
  warehouse_id      uuid,
  branch_id         uuid,
  layer_count       integer,
  qty_on_hand       numeric,
  total_value       numeric,
  oldest_receipt_at timestamptz,
  zero_cost_layers  integer
)
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
  )
  SELECT
    ls.product_id,
    ls.warehouse_id,
    MIN(ls.branch_id)                                        AS branch_id,
    COUNT(*) FILTER (WHERE ls.qty_as_of <> 0)::int           AS layer_count,
    COALESCE(SUM(ls.qty_as_of), 0)                           AS qty_on_hand,
    COALESCE(SUM(ls.qty_as_of * ls.unit_cost), 0)            AS total_value,
    MIN(ls.received_at) FILTER (WHERE ls.qty_as_of > 0)      AS oldest_receipt_at,
    COUNT(*) FILTER (WHERE ls.qty_as_of <> 0
                       AND COALESCE(ls.unit_cost, 0) = 0)::int AS zero_cost_layers
  FROM layer_state ls
  GROUP BY ls.product_id, ls.warehouse_id;
END;
$function$;

-- Internal only: SECURITY DEFINER callers execute it with the owner's
-- privileges, so no direct grant to authenticated is needed or wanted.
REVOKE ALL ON FUNCTION public._inventory_layer_valuation_as_of(uuid, uuid, date, uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._inventory_layer_valuation_as_of(uuid, uuid, date, uuid, uuid, uuid, uuid) TO service_role;

-- ------------------------------- valuation report, now on the helper
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
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  PERFORM public._assert_org_member(p_org);
  PERFORM public._assert_inventory_report_access(p_business, p_branch);

  RETURN QUERY
  WITH agg AS (
    SELECT * FROM public._inventory_layer_valuation_as_of(
      p_org, p_business, p_as_of, p_branch, p_warehouse, p_product, p_category)
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

REVOKE ALL ON FUNCTION public.report_inventory_valuation_as_of(uuid, uuid, date, uuid, uuid, uuid, uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_inventory_valuation_as_of(uuid, uuid, date, uuid, uuid, uuid, uuid, integer, integer)
  TO authenticated, service_role;

-- ------------------------------------- reconciliation on the same basis
DROP FUNCTION IF EXISTS public.reconcile_inventory_subledger_to_gl(uuid, uuid, date, uuid);

CREATE OR REPLACE FUNCTION public.reconcile_inventory_subledger_to_gl(
  p_org      uuid,
  p_business uuid DEFAULT NULL::uuid,
  p_as_of    date DEFAULT NULL::date,
  p_branch   uuid DEFAULT NULL::uuid
)
RETURNS TABLE(
  account_id            uuid,
  account_code          text,
  account_name          text,
  business_id           uuid,
  subledger_value       numeric,
  gl_closing            numeric,
  drift                 numeric,
  unlayered_positions   integer,
  zero_cost_positions   integer,
  negative_qty_positions integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_as_of date := COALESCE(p_as_of, current_date);
  v_guard boolean := NOT public._is_trusted_inventory_diag_context();
BEGIN
  PERFORM public._assert_org_member(p_org);

  -- p_business is an authorization boundary, not a filter. The reconciliation
  -- is an ENTITY-level integrity check (the inventory control account belongs
  -- to the legal entity); p_branch is accepted for signature compatibility and
  -- is applied symmetrically to BOTH sides when supplied, never to one only.
  IF p_business IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_RECON_BUSINESS_REQUIRED: a company must be selected'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._assert_inventory_report_access(p_business, p_branch);

  RETURN QUERY
  WITH control AS (
    SELECT DISTINCT das.account_id, das.business_id
    FROM public.default_account_settings das
    WHERE das.organization_id = p_org
      AND das.setting_key = 'inventory'
      AND das.account_id IS NOT NULL
      AND (das.business_id IS NULL OR das.business_id = p_business)
  ),
  -- Authoritative subledger: the SAME layer arithmetic the Inventory
  -- Valuation report uses, reconstructed at v_as_of.
  layers AS (
    SELECT * FROM public._inventory_layer_valuation_as_of(
      p_org, p_business, v_as_of, p_branch, NULL, NULL, NULL)
  ),
  positioned AS (
    SELECT
      COALESCE(
        p.inventory_account_id,
        (SELECT c.account_id FROM control c
          ORDER BY (c.business_id IS NULL) LIMIT 1)
      ) AS acct,
      l.qty_on_hand,
      l.total_value,
      l.zero_cost_layers
    FROM layers l
    JOIN public.products p ON p.id = l.product_id
  ),
  sub AS (
    SELECT
      x.acct,
      COALESCE(SUM(x.total_value), 0)                                   AS value,
      COUNT(*) FILTER (WHERE x.zero_cost_layers > 0)::int               AS zero_cost_positions,
      COUNT(*) FILTER (WHERE x.qty_on_hand < 0)::int                    AS negative_positions
    FROM positioned x
    WHERE x.acct IS NOT NULL
    GROUP BY x.acct
  ),
  -- Positions the layer ledger cannot value at all: real quantity on the
  -- operational snapshot with no cost layer behind it. Surfaced, never
  -- silently absorbed into the subledger total.
  unlayered AS (
    SELECT
      COALESCE(
        p.inventory_account_id,
        (SELECT c.account_id FROM control c
          ORDER BY (c.business_id IS NULL) LIMIT 1)
      ) AS acct,
      COUNT(*)::int AS positions
    FROM public.warehouse_stock ws
    JOIN public.products p ON p.id = ws.product_id
    WHERE ws.organization_id = p_org
      AND ws.business_id = p_business
      AND ws.quantity <> 0
      AND (p_branch IS NULL OR ws.branch_id = p_branch)
      AND (NOT v_guard OR ws.branch_id IS NULL
           OR public.can_access_branch(auth.uid(), ws.branch_id))
      AND NOT EXISTS (
        SELECT 1 FROM layers l
         WHERE l.product_id = ws.product_id
           AND l.warehouse_id IS NOT DISTINCT FROM ws.warehouse_id
           AND l.layer_count > 0
      )
    GROUP BY 1
  ),
  gl AS (
    SELECT
      jel.account_id AS acct,
      COALESCE(SUM(COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)), 0) AS closing
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.organization_id = p_org
      AND je.status = 'posted'
      AND je.entry_date <= v_as_of
      AND je.business_id = p_business
      AND (p_branch IS NULL OR je.branch_id = p_branch)
      AND (NOT v_guard OR je.branch_id IS NULL
           OR public.can_access_branch(auth.uid(), je.branch_id))
    GROUP BY jel.account_id
  )
  SELECT
    a.id,
    a.code::text,
    a.name::text,
    c.business_id,
    ROUND(COALESCE(sub.value, 0), 2),
    ROUND(COALESCE(gl.closing, 0), 2),
    ROUND(COALESCE(sub.value, 0) - COALESCE(gl.closing, 0), 2),
    COALESCE(u.positions, 0),
    COALESCE(sub.zero_cost_positions, 0),
    COALESCE(sub.negative_positions, 0)
  FROM control c
  JOIN public.accounts a ON a.id = c.account_id
  LEFT JOIN sub ON sub.acct = c.account_id
  LEFT JOIN gl ON gl.acct = c.account_id
  LEFT JOIN unlayered u ON u.acct = c.account_id
  ORDER BY a.code;
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_inventory_subledger_to_gl(uuid, uuid, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_inventory_subledger_to_gl(uuid, uuid, date, uuid)
  TO authenticated, service_role;

-- ---------------------- drift explanation on the same as-at layer data
CREATE OR REPLACE FUNCTION public.explain_inventory_gl_drift(
  p_org uuid,
  p_business uuid DEFAULT NULL::uuid,
  p_as_of date DEFAULT NULL::date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_as_of date := COALESCE(p_as_of, current_date);
  v_drift numeric := 0;
  v_missing_je_count integer := 0;
  v_missing_je_value numeric := 0;
  v_zero_cost_qty numeric := 0;
  v_zero_cost_lines integer := 0;
  v_negative_value numeric := 0;
  v_negative_lines integer := 0;
  v_unlayered integer := 0;
  v_foreign_source numeric := 0;
  v_accounts uuid[];
BEGIN
  PERFORM public._assert_org_member(p_org);
  IF p_business IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_RECON_BUSINESS_REQUIRED: a company must be selected'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._assert_inventory_report_access(p_business, NULL);

  SELECT COALESCE(SUM(r.drift), 0),
         COALESCE(SUM(r.unlayered_positions), 0)
    INTO v_drift, v_unlayered
  FROM public.reconcile_inventory_subledger_to_gl(p_org, p_business, v_as_of) r;

  SELECT array_agg(DISTINCT das.account_id) INTO v_accounts
  FROM public.default_account_settings das
  WHERE das.organization_id = p_org
    AND das.setting_key = 'inventory'
    AND das.account_id IS NOT NULL
    AND (das.business_id IS NULL OR das.business_id = p_business);

  -- Approved adjustments that moved stock but posted no journal entry
  SELECT COUNT(*), COALESCE(SUM(COALESCE(sa.total_value, 0)), 0)
  INTO v_missing_je_count, v_missing_je_value
  FROM public.stock_adjustments sa
  WHERE sa.organization_id = p_org
    AND sa.business_id = p_business
    AND sa.status = 'approved'
    AND sa.adjustment_date <= v_as_of
    AND NOT EXISTS (
      SELECT 1 FROM public.journal_entries je
      WHERE je.source_type = 'stock_adjustment' AND je.source_id = sa.id
    );

  -- Zero-cost and negative positions, measured on the SAME as-at layer data
  -- the subledger total is built from.
  SELECT
    COUNT(*) FILTER (WHERE l.zero_cost_layers > 0)::int,
    COALESCE(SUM(l.qty_on_hand) FILTER (WHERE l.zero_cost_layers > 0), 0),
    COUNT(*) FILTER (WHERE l.qty_on_hand < 0)::int,
    COALESCE(SUM(l.total_value) FILTER (WHERE l.qty_on_hand < 0), 0)
  INTO v_zero_cost_lines, v_zero_cost_qty, v_negative_lines, v_negative_value
  FROM public._inventory_layer_valuation_as_of(p_org, p_business, v_as_of) l;

  -- Postings into an inventory control account from a non-inventory source
  IF v_accounts IS NOT NULL THEN
    SELECT COALESCE(SUM(COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)), 0)
    INTO v_foreign_source
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.organization_id = p_org
      AND je.status = 'posted'
      AND je.entry_date <= v_as_of
      AND je.business_id = p_business
      AND jel.account_id = ANY(v_accounts)
      AND COALESCE(je.source_type, 'manual') NOT IN (
        'stock_adjustment', 'stock_adjustment_backfill', 'goods_receipt',
        'purchase_bill', 'bill', 'invoice', 'sales_invoice', 'pos_sale',
        'stock_transfer', 'inventory_revaluation', 'migration'
      );
  END IF;

  RETURN jsonb_build_object(
    'as_of', v_as_of,
    'drift', v_drift,
    'components', jsonb_build_array(
      jsonb_build_object('code', 'missing_adjustment_journals',
                         'label', 'Approved adjustments with no journal entry',
                         'count', v_missing_je_count, 'amount', v_missing_je_value),
      jsonb_build_object('code', 'zero_cost_stock',
                         'label', 'Stock on hand carried at zero cost',
                         'count', v_zero_cost_lines, 'amount', 0, 'quantity', v_zero_cost_qty),
      jsonb_build_object('code', 'negative_stock',
                         'label', 'Negative stock positions in the subledger',
                         'count', v_negative_lines, 'amount', v_negative_value),
      jsonb_build_object('code', 'unlayered_stock',
                         'label', 'Positions with quantity but no cost layer',
                         'count', v_unlayered, 'amount', 0),
      jsonb_build_object('code', 'foreign_source_postings',
                         'label', 'Inventory account postings from a non-inventory source',
                         'count', NULL, 'amount', v_foreign_source)
    ),
    'unexplained', ROUND(v_drift - v_missing_je_value - v_negative_value - v_foreign_source, 2)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.explain_inventory_gl_drift(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.explain_inventory_gl_drift(uuid, uuid, date)
  TO authenticated, service_role;