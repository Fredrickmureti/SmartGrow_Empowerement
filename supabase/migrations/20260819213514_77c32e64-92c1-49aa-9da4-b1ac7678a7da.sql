-- =====================================================================
-- Inventory reporting security hardening (Phase 1)
-- Plan: .lovable/plan/inventory-stock-reporting-investigation-findings-and-phased-2026-08-19.md
--
-- Findings addressed:
--   1. check_inventory_valuation_drift / check_valuation_writer_coverage /
--      check_movement_reversal_coverage were SECURITY DEFINER, executable by
--      anon, and contained no authorization check at all.
--   2. reconcile_inventory_subledger_to_gl asserted org membership only, so
--      p_business was a caller-supplied filter rather than an authorization
--      boundary; branch was ignored entirely.
--   3. cost_layers / cost_layer_consumptions RLS was org-scoped, not
--      business-scoped, unlike every other stock table.
-- =====================================================================

-- ---------------------------------------------------------------- guards
-- Trusted contexts (migrations, pgTAP self-tests, service_role jobs) keep
-- unrestricted access; every request that arrives through the Data API is
-- authorized against the caller's business membership.
CREATE OR REPLACE FUNCTION public._is_trusted_inventory_diag_context()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT session_user IN ('postgres', 'supabase_admin', 'service_role');
$$;

CREATE OR REPLACE FUNCTION public._assert_inventory_diag_authenticated()
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF public._is_trusted_inventory_diag_context() THEN
    RETURN;
  END IF;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_DIAG_UNAUTHENTICATED: sign-in required'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._assert_inventory_diag_business(_business_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF public._is_trusted_inventory_diag_context() THEN
    RETURN;
  END IF;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_DIAG_UNAUTHENTICATED: sign-in required'
      USING ERRCODE = '42501';
  END IF;
  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_DIAG_BUSINESS_REQUIRED: a business_id must be supplied'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), _business_id) THEN
    RAISE EXCEPTION 'INVENTORY_DIAG_FORBIDDEN: no access to business %', _business_id
      USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._assert_inventory_diag_authenticated() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._assert_inventory_diag_business(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._is_trusted_inventory_diag_context() FROM PUBLIC, anon;

-- ------------------------------------------- valuation drift (tenant data)
CREATE OR REPLACE FUNCTION public.check_inventory_valuation_drift(
  _business_id uuid DEFAULT NULL::uuid,
  _tolerance numeric DEFAULT 0.01
)
RETURNS TABLE(scope text, business_id uuid, warehouse_id uuid, product_id uuid,
              avco_qty numeric, avco_unit_cost numeric, avco_value numeric,
              layer_qty numeric, layer_value numeric, value_drift numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._assert_inventory_diag_business(_business_id);

  RETURN QUERY
  WITH layers AS (
    SELECT cl.business_id, cl.warehouse_id, cl.product_id,
           SUM(cl.qty_remaining) AS qty,
           SUM(cl.qty_remaining * cl.unit_cost) AS value
      FROM public.cost_layers cl
     WHERE (_business_id IS NULL OR cl.business_id = _business_id)
     GROUP BY 1, 2, 3
  ),
  wh AS (
    SELECT ws.business_id, ws.warehouse_id, ws.product_id,
           COALESCE(ws.quantity, 0) AS qty,
           COALESCE(ws.average_cost, 0) AS unit_cost,
           ROUND(COALESCE(ws.quantity, 0) * COALESCE(ws.average_cost, 0), 2) AS value
      FROM public.warehouse_stock ws
     WHERE (_business_id IS NULL OR ws.business_id = _business_id)
  )
  SELECT 'warehouse_avco_vs_layers'::text,
         wh.business_id, wh.warehouse_id, wh.product_id,
         wh.qty, wh.unit_cost, wh.value,
         COALESCE(l.qty, 0), ROUND(COALESCE(l.value, 0), 2),
         ROUND(wh.value - COALESCE(l.value, 0), 2)
    FROM wh
    LEFT JOIN layers l
      ON l.business_id = wh.business_id
     AND l.product_id = wh.product_id
     AND l.warehouse_id IS NOT DISTINCT FROM wh.warehouse_id
   WHERE ABS(wh.value - ROUND(COALESCE(l.value, 0), 2))
         > GREATEST(_tolerance, ROUND(ABS(wh.qty) * 0.00005, 2))

  UNION ALL

  -- products.cost_price is numeric(15,2); the layer AVCO carries four
  -- decimals. Allow half a cent per unit of rounding before calling it drift.
  SELECT 'product_avco_vs_layers'::text,
         p.business_id, NULL::uuid, p.id,
         COALESCE(p.stock_quantity, 0),
         COALESCE(p.cost_price, 0),
         ROUND(COALESCE(p.stock_quantity, 0) * COALESCE(p.cost_price, 0), 2),
         COALESCE(pl.qty, 0), ROUND(COALESCE(pl.value, 0), 2),
         ROUND(COALESCE(p.stock_quantity, 0) * COALESCE(p.cost_price, 0)
               - COALESCE(pl.value, 0), 2)
    FROM public.products p
    LEFT JOIN (
      SELECT l2.business_id, l2.product_id, SUM(l2.qty) AS qty, SUM(l2.value) AS value
        FROM layers l2 GROUP BY 1, 2
    ) pl ON pl.business_id = p.business_id AND pl.product_id = p.id
   WHERE (_business_id IS NULL OR p.business_id = _business_id)
     AND ABS(ROUND(COALESCE(p.stock_quantity, 0) * COALESCE(p.cost_price, 0), 2)
             - ROUND(COALESCE(pl.value, 0), 2))
         > GREATEST(_tolerance, ROUND(ABS(COALESCE(p.stock_quantity, 0)) * 0.005, 2));
END;
$function$;

-- ------------------------------------- writer coverage (schema metadata only)
CREATE OR REPLACE FUNCTION public.check_valuation_writer_coverage()
RETURNS TABLE(issue text, function_name text, detail text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._assert_inventory_diag_authenticated();

  RETURN QUERY
  SELECT 'unregistered_valuation_writer'::text,
         p.proname::text,
         'writes AVCO or cost layers but is absent from inventory_valuation_writers'::text
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND (
       p.prosrc ~* 'update\s+(public\.)?warehouse_stock[\s\S]{0,200}average_cost'
       OR p.prosrc ~* 'update\s+(public\.)?products[\s\S]{0,200}cost_price'
       OR p.prosrc ~* '(insert\s+into|update)\s+(public\.)?cost_layers'
     )
     AND p.proname NOT IN (SELECT w.function_name FROM public.inventory_valuation_writers w)
     AND p.proname NOT IN ('check_valuation_writer_coverage', 'check_inventory_valuation_drift',
                           'enforce_valuation_write_authority')
  UNION ALL
  SELECT 'stale_registration'::text,
         w.function_name,
         'registered valuation writer no longer exists in the database'::text
    FROM public.inventory_valuation_writers w
   WHERE NOT EXISTS (
           SELECT 1 FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = w.function_name
         );
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_movement_reversal_coverage()
RETURNS TABLE(issue text, function_name text, detail text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._assert_inventory_diag_authenticated();

  RETURN QUERY
  WITH writers AS (
    SELECT DISTINCT p.proname AS fn
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND pg_get_functiondef(p.oid) ~* 'INSERT INTO (public\.)?stock_movements'
  )
  SELECT 'unregistered_writer'::text, w.fn,
         'writes stock_movements but is absent from stock_movement_writers'::text
    FROM writers w
    LEFT JOIN public.stock_movement_writers r ON r.function_name = w.fn
   WHERE r.function_name IS NULL

  UNION ALL
  SELECT 'stale_registration'::text, r.function_name,
         'registered writer no longer writes stock_movements'::text
    FROM public.stock_movement_writers r
    LEFT JOIN writers w ON w.fn = r.function_name
   WHERE w.fn IS NULL

  UNION ALL
  SELECT 'missing_reversal'::text, r.function_name,
         'reversal function ' || r.reversal_function || ' does not exist'::text
    FROM public.stock_movement_writers r
   WHERE r.reversal_function IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = r.reversal_function
     );
END;
$function$;

REVOKE ALL ON FUNCTION public.check_inventory_valuation_drift(uuid, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.check_valuation_writer_coverage() FROM anon;
REVOKE ALL ON FUNCTION public.check_movement_reversal_coverage() FROM anon;
GRANT EXECUTE ON FUNCTION public.check_inventory_valuation_drift(uuid, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_valuation_writer_coverage() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_movement_reversal_coverage() TO authenticated, service_role;

-- ------------------------------------------ inventory <-> GL reconciliation
CREATE OR REPLACE FUNCTION public.reconcile_inventory_subledger_to_gl(
  p_org uuid,
  p_business uuid DEFAULT NULL::uuid,
  p_as_of date DEFAULT NULL::date,
  p_branch uuid DEFAULT NULL::uuid
)
RETURNS TABLE(account_id uuid, account_code text, account_name text, business_id uuid,
              subledger_value numeric, gl_closing numeric, drift numeric,
              fallback_cost_lines integer, zero_cost_lines integer, negative_qty_lines integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_as_of  date := COALESCE(p_as_of, current_date);
  v_guard  boolean := NOT public._is_trusted_inventory_diag_context();
BEGIN
  PERFORM public._assert_org_member(p_org);

  IF v_guard THEN
    -- p_business is an authorization boundary, not a filter: a member of the
    -- organization must still be authorized for the specific business.
    PERFORM public._assert_inventory_diag_business(p_business);
    IF p_branch IS NOT NULL AND NOT public.can_access_branch(auth.uid(), p_branch) THEN
      RAISE EXCEPTION 'INVENTORY_DIAG_FORBIDDEN: no access to branch %', p_branch
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
  WITH control AS (
    SELECT DISTINCT das.account_id, das.business_id
    FROM public.default_account_settings das
    WHERE das.organization_id = p_org
      AND das.setting_key = 'inventory'
      AND das.account_id IS NOT NULL
      AND (p_business IS NULL OR das.business_id IS NULL OR das.business_id = p_business)
  ),
  stock AS (
    SELECT
      COALESCE(p.inventory_account_id, (SELECT c.account_id FROM control c
                                        WHERE c.business_id IS NULL
                                           OR c.business_id = ws.business_id
                                        LIMIT 1)) AS acct,
      ws.quantity AS qty,
      COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0) AS unit_cost,
      (ws.average_cost IS NULL OR ws.average_cost = 0) AS is_fallback
    FROM public.warehouse_stock ws
    JOIN public.products p ON p.id = ws.product_id
    WHERE ws.organization_id = p_org
      AND (p_business IS NULL OR ws.business_id = p_business)
      AND (p_branch IS NULL OR ws.branch_id = p_branch)
      AND (NOT v_guard OR ws.branch_id IS NULL
           OR public.can_access_branch(auth.uid(), ws.branch_id))
  ),
  sub AS (
    SELECT
      s.acct,
      COALESCE(SUM(s.qty * s.unit_cost), 0) AS value,
      COUNT(*) FILTER (WHERE s.is_fallback AND s.qty <> 0)::int AS fallback_lines,
      COUNT(*) FILTER (WHERE s.unit_cost = 0 AND s.qty <> 0)::int AS zero_lines,
      COUNT(*) FILTER (WHERE s.qty < 0)::int AS neg_lines
    FROM stock s
    WHERE s.acct IS NOT NULL
    GROUP BY s.acct
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
      AND (p_business IS NULL OR je.business_id = p_business)
      AND (p_branch IS NULL OR je.branch_id = p_branch)
      AND (NOT v_guard OR je.branch_id IS NULL
           OR public.can_access_branch(auth.uid(), je.branch_id))
    GROUP BY jel.account_id
  )
  SELECT
    a.id,
    a.code,
    a.name,
    c.business_id,
    COALESCE(sub.value, 0),
    COALESCE(gl.closing, 0),
    COALESCE(sub.value, 0) - COALESCE(gl.closing, 0),
    COALESCE(sub.fallback_lines, 0),
    COALESCE(sub.zero_lines, 0),
    COALESCE(sub.neg_lines, 0)
  FROM control c
  JOIN public.accounts a ON a.id = c.account_id
  LEFT JOIN sub ON sub.acct = c.account_id
  LEFT JOIN gl ON gl.acct = c.account_id
  ORDER BY a.code;
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_inventory_subledger_to_gl(uuid, uuid, date, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.reconcile_inventory_subledger_to_gl(uuid, uuid, date, uuid)
  TO authenticated, service_role;

-- ------------------------------------------------- value ledger RLS scoping
DROP POLICY IF EXISTS "Org members read cost layers" ON public.cost_layers;
CREATE POLICY "cost_layers_select_business_scoped"
  ON public.cost_layers FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS "Org members read cost consumptions" ON public.cost_layer_consumptions;
CREATE POLICY "cost_layer_consumptions_select_business_scoped"
  ON public.cost_layer_consumptions FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));