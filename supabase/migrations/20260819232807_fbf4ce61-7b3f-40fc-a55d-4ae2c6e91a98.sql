-- =====================================================================
-- Phase 6b — valuation-basis convergence for inventory integrity helpers
--
-- Findings addressed:
--   1. list_inventory_subledger_composition "defended" the subledger figure
--      line by line, but on the AVCO / product-cost basis. After Phase 6 the
--      subledger total comes from the cost-layer ledger, so the composition
--      could never sum to the number it claims to explain.
--   2. list_negative_stock_positions and the stock_negative findings view
--      presented an AVCO-derived amount as "valuation impact", implying it is
--      an accounting valuation. It is an operational-snapshot estimate.
--   3. backfill_opening_inventory_gl posted a product-cost estimate with no
--      reference to the drift actually measured by the reconciliation.
--
-- Rule after this migration: any figure that claims to be inventory VALUE
-- comes from public._inventory_layer_valuation_as_of(). Anything still derived
-- from warehouse_stock.average_cost / products.cost_price is explicitly named
-- and documented as an AVCO estimate or divergence check.
-- =====================================================================

-- ---------------------------------------------------------------
-- 1. Subledger composition, re-based on the authoritative layer ledger
-- ---------------------------------------------------------------
DROP FUNCTION IF EXISTS public.list_inventory_subledger_composition(uuid, uuid, integer);

CREATE OR REPLACE FUNCTION public.list_inventory_subledger_composition(
  p_org      uuid,
  p_business uuid DEFAULT NULL::uuid,
  p_as_of    date DEFAULT NULL::date,
  p_limit    integer DEFAULT 500,
  p_branch   uuid DEFAULT NULL::uuid
)
RETURNS TABLE(
  warehouse_id   uuid,
  warehouse_name text,
  product_id     uuid,
  product_name   text,
  sku            text,
  quantity       numeric,
  unit_cost      numeric,
  cost_basis     text,
  value          numeric
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

  -- Same authorization contract as reconcile_inventory_subledger_to_gl: the
  -- composition explains an entity-level control-account figure.
  IF p_business IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_RECON_BUSINESS_REQUIRED: a company must be selected'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._assert_inventory_report_access(p_business, p_branch);

  RETURN QUERY
  WITH layers AS (
    SELECT * FROM public._inventory_layer_valuation_as_of(
      p_org, p_business, v_as_of, p_branch, NULL, NULL, NULL)
  ),
  -- Valued positions: the very rows summed into subledger_value.
  layered AS (
    SELECT
      l.warehouse_id,
      w.name::text AS warehouse_name,
      l.product_id,
      p.name::text AS product_name,
      p.sku::text  AS sku,
      l.qty_on_hand AS quantity,
      CASE WHEN l.qty_on_hand <> 0
           THEN ROUND(l.total_value / l.qty_on_hand, 6)
           ELSE 0 END AS unit_cost,
      CASE
        WHEN l.qty_on_hand < 0            THEN 'negative_layer'
        WHEN l.zero_cost_layers > 0       THEN 'zero_cost_layer'
        ELSE 'cost_layer'
      END AS cost_basis,
      ROUND(l.total_value, 2) AS value
    FROM layers l
    JOIN public.products p ON p.id = l.product_id
    LEFT JOIN public.warehouses w ON w.id = l.warehouse_id
    WHERE l.qty_on_hand <> 0 OR l.total_value <> 0
  ),
  -- Positions the layer ledger cannot value: quantity on the operational
  -- snapshot with no layer behind it. Listed at zero value so the column
  -- still sums to subledger_value, and flagged so nobody mistakes the
  -- omission for a valuation.
  unlayered AS (
    SELECT
      ws.warehouse_id,
      w.name::text,
      ws.product_id,
      p.name::text,
      p.sku::text,
      ws.quantity,
      0::numeric,
      'unlayered'::text,
      0::numeric
    FROM public.warehouse_stock ws
    JOIN public.products p ON p.id = ws.product_id
    LEFT JOIN public.warehouses w ON w.id = ws.warehouse_id
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
  )
  SELECT * FROM (
    SELECT * FROM layered
    UNION ALL
    SELECT * FROM unlayered
  ) rows_out
  ORDER BY abs(rows_out.value) DESC, rows_out.product_name
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
END;
$function$;

REVOKE ALL ON FUNCTION public.list_inventory_subledger_composition(uuid, uuid, date, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_inventory_subledger_composition(uuid, uuid, date, integer, uuid)
  TO authenticated, service_role;

-- ---------------------------------------------------------------
-- 2. Negative stock: an OPERATIONAL defect, reported with an explicitly
--    named AVCO estimate (there are no layers behind negative quantity).
-- ---------------------------------------------------------------
CREATE OR REPLACE VIEW public.accounting_integrity_findings_stock_negative AS
SELECT
  gen_random_uuid() AS id,
  ws.organization_id,
  ws.business_id,
  ws.branch_id,
  'critical'::text AS severity,
  'stock_negative_quantity'::text AS finding_code,
  'Stock on hand is negative'::text AS finding_title,
  format(
    'Product %s in warehouse %s has quantity %s. Negative stock cannot be valued from the cost-layer ledger and corrupts the inventory control account.',
    COALESCE(p.name, 'unknown'), COALESCE(w.name, 'unknown'), ws.quantity
  ) AS finding_detail,
  'product'::text AS entity_type,
  ws.product_id AS entity_id,
  COALESCE(p.sku, p.name) AS entity_ref,
  jsonb_build_object(
    'warehouse_id', ws.warehouse_id,
    'warehouse_name', w.name,
    'quantity', ws.quantity,
    -- Named for what it is: an AVCO / product-cost ESTIMATE of exposure, not
    -- an accounting valuation. Accounting value comes only from
    -- _inventory_layer_valuation_as_of().
    'avco_unit_cost', COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0),
    'avco_exposure_estimate', ws.quantity * COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0)
  ) AS evidence,
  now() AS detected_at
FROM public.warehouse_stock ws
JOIN public.products p ON p.id = ws.product_id
LEFT JOIN public.warehouses w ON w.id = ws.warehouse_id
WHERE ws.quantity < 0;

DROP FUNCTION IF EXISTS public.list_negative_stock_positions(uuid, uuid);

CREATE OR REPLACE FUNCTION public.list_negative_stock_positions(
  p_org      uuid,
  p_business uuid DEFAULT NULL::uuid
)
RETURNS TABLE(
  product_id             uuid,
  product_name           text,
  sku                    text,
  warehouse_id           uuid,
  warehouse_name         text,
  quantity               numeric,
  avco_unit_cost         numeric,
  avco_exposure_estimate numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._assert_org_member(p_org);

  IF p_business IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_RECON_BUSINESS_REQUIRED: a company must be selected'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._assert_inventory_report_access(p_business, NULL);

  RETURN QUERY
  SELECT
    ws.product_id,
    p.name::text,
    p.sku::text,
    ws.warehouse_id,
    w.name::text,
    ws.quantity,
    COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0),
    ROUND(ws.quantity * COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0), 2)
  FROM public.warehouse_stock ws
  JOIN public.products p ON p.id = ws.product_id
  LEFT JOIN public.warehouses w ON w.id = ws.warehouse_id
  WHERE ws.organization_id = p_org
    AND ws.business_id = p_business
    AND ws.quantity < 0
  ORDER BY ws.quantity ASC
  LIMIT 500;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_negative_stock_positions(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_negative_stock_positions(uuid, uuid)
  TO authenticated, service_role;

-- ---------------------------------------------------------------
-- 3. Opening-inventory backfill: keep the product-cost estimate (positions
--    with no layer have no other basis) but name the basis, measure it
--    against the layer-basis drift, and never post when the reconciliation
--    says there is nothing to close.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backfill_opening_inventory_gl(
  p_org uuid,
  p_business uuid DEFAULT NULL::uuid,
  p_as_of date DEFAULT NULL::date,
  p_dry_run boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_business uuid := p_business;
  v_business_count integer := 0;
  v_inv_account uuid;
  v_obe_account uuid;
  v_total numeric := 0;
  v_first_date date;
  v_entry_date date;
  v_je_id uuid;
  v_existing uuid;
  v_layer_drift numeric := 0;
BEGIN
  PERFORM public._assert_org_member(p_org);

  IF v_business IS NULL THEN
    SELECT COUNT(*) INTO v_business_count FROM public.businesses WHERE organization_id = p_org;
    IF v_business_count <> 1 THEN
      RAISE EXCEPTION 'Select a company before posting the opening inventory journal (% companies in this organization)', v_business_count;
    END IF;
    SELECT id INTO v_business FROM public.businesses WHERE organization_id = p_org;
  ELSIF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = v_business AND organization_id = p_org) THEN
    RAISE EXCEPTION 'Company does not belong to this organization';
  END IF;

  SELECT id INTO v_existing FROM public.journal_entries
    WHERE organization_id = p_org
      AND business_id = v_business
      AND is_opening_entry = true
      AND source_type = 'stock_adjustment_backfill'
    LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'opening_already_posted',
                              'journal_entry_id', v_existing, 'dry_run', p_dry_run);
  END IF;

  SELECT account_id INTO v_inv_account FROM public.default_account_settings
    WHERE organization_id = p_org AND setting_key = 'inventory'
      AND (business_id IS NULL OR business_id = v_business)
    ORDER BY business_id NULLS LAST LIMIT 1;
  SELECT account_id INTO v_obe_account FROM public.default_account_settings
    WHERE organization_id = p_org AND setting_key = 'opening_balance_equity'
      AND (business_id IS NULL OR business_id = v_business)
    ORDER BY business_id NULLS LAST LIMIT 1;

  IF v_inv_account IS NULL OR v_obe_account IS NULL THEN
    RAISE EXCEPTION 'Inventory or Opening Balance Equity default accounts are not configured';
  END IF;

  -- Opening quantity that entered stock with no cost on the movement. Product
  -- cost is the only available basis for these positions precisely because no
  -- cost layer exists behind them; the basis is reported explicitly.
  SELECT
    COALESCE(SUM(sm.quantity * COALESCE(p.cost_price, 0)), 0),
    MIN(sm.created_at)::date
  INTO v_total, v_first_date
  FROM public.stock_movements sm
  JOIN public.products p ON p.id = sm.product_id
  WHERE sm.organization_id = p_org
    AND (sm.business_id IS NULL OR sm.business_id = v_business)
    AND sm.movement_type = 'adjustment'
    AND COALESCE(sm.unit_cost, 0) = 0
    AND COALESCE(p.cost_price, 0) > 0
    AND sm.quantity > 0;

  v_entry_date := COALESCE(p_as_of, v_first_date, current_date);

  IF v_total = 0 THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'no_zero_cost_opening_movements',
                              'basis', 'product_cost_estimate', 'dry_run', p_dry_run);
  END IF;

  -- Authoritative measure of what is actually missing from the GL at that
  -- date, on the layer basis. Posting more than this would create new drift.
  SELECT COALESCE(SUM(r.drift), 0) INTO v_layer_drift
  FROM public.reconcile_inventory_subledger_to_gl(p_org, v_business, v_entry_date) r;

  IF v_layer_drift <= 0 THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'no_layer_basis_drift',
                              'basis', 'product_cost_estimate',
                              'entry_date', v_entry_date,
                              'estimated_total', v_total,
                              'layer_basis_drift', v_layer_drift,
                              'dry_run', p_dry_run);
  END IF;

  IF public.is_period_locked(p_org, v_business, v_entry_date) THEN
    IF p_dry_run THEN
      RETURN jsonb_build_object('skipped', true, 'reason', 'period_locked',
                                'entry_date', v_entry_date, 'total', v_total,
                                'basis', 'product_cost_estimate',
                                'layer_basis_drift', v_layer_drift, 'dry_run', true);
    END IF;
    RAISE EXCEPTION 'Accounting period containing % is locked', v_entry_date;
  END IF;

  -- Never post more than the measured layer-basis drift.
  v_total := LEAST(v_total, v_layer_drift);

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'dry_run', true,
      'business_id', v_business,
      'entry_date', v_entry_date,
      'total_posted', v_total,
      'basis', 'product_cost_estimate',
      'layer_basis_drift', v_layer_drift,
      'debit_account_id', v_inv_account,
      'credit_account_id', v_obe_account
    );
  END IF;

  v_je_id := public.post_journal_entry_atomic(
    p_org, v_business,
    public.generate_next_je_number(p_org, v_business),
    v_entry_date,
    NULL,
    'Opening Inventory — reconciliation backfill',
    'stock_adjustment_backfill', NULL, auth.uid(), false, false,
    jsonb_build_array(
      jsonb_build_object('account_id', v_inv_account, 'debit', v_total, 'credit', 0,
        'description', 'Opening inventory at product cost (no cost layers available)'),
      jsonb_build_object('account_id', v_obe_account, 'debit', 0, 'credit', v_total,
        'description', 'Opening Balance Equity')
    ),
    NULL, NULL, NULL, NULL, true
  );

  RETURN jsonb_build_object(
    'success', true,
    'dry_run', false,
    'journal_entry_id', v_je_id,
    'business_id', v_business,
    'total_posted', v_total,
    'basis', 'product_cost_estimate',
    'layer_basis_drift', v_layer_drift,
    'entry_date', v_entry_date
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.backfill_opening_inventory_gl(uuid, uuid, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.backfill_opening_inventory_gl(uuid, uuid, date, boolean)
  TO authenticated, service_role;