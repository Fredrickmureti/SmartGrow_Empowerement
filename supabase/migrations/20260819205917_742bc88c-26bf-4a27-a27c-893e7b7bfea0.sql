-- =====================================================================
-- Inventory <-> GL reconciliation: correctness + safety hardening
-- =====================================================================

-- ---------------------------------------------------------------
-- A. Negative stock (replaces broken detect_negative_asset_findings)
-- ---------------------------------------------------------------
DROP FUNCTION IF EXISTS public.detect_negative_asset_findings(uuid);

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
    'Product %s in warehouse %s has quantity %s. Negative stock corrupts inventory valuation and the inventory control account.',
    COALESCE(p.name, 'unknown'), COALESCE(w.name, 'unknown'), ws.quantity
  ) AS finding_detail,
  'product'::text AS entity_type,
  ws.product_id AS entity_id,
  COALESCE(p.sku, p.name) AS entity_ref,
  jsonb_build_object(
    'warehouse_id', ws.warehouse_id,
    'warehouse_name', w.name,
    'quantity', ws.quantity,
    'unit_cost', COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0),
    'valuation_impact', ws.quantity * COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0)
  ) AS evidence,
  now() AS detected_at
FROM public.warehouse_stock ws
JOIN public.products p ON p.id = ws.product_id
LEFT JOIN public.warehouses w ON w.id = ws.warehouse_id
WHERE ws.quantity < 0;

CREATE OR REPLACE FUNCTION public.list_negative_stock_positions(
  p_org uuid,
  p_business uuid DEFAULT NULL
)
RETURNS TABLE(
  product_id uuid,
  product_name text,
  sku text,
  warehouse_id uuid,
  warehouse_name text,
  quantity numeric,
  unit_cost numeric,
  valuation_impact numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ws.product_id,
    p.name,
    p.sku,
    ws.warehouse_id,
    w.name,
    ws.quantity,
    COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0),
    ws.quantity * COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0)
  FROM public.warehouse_stock ws
  JOIN public.products p ON p.id = ws.product_id
  LEFT JOIN public.warehouses w ON w.id = ws.warehouse_id
  WHERE ws.organization_id = p_org
    AND (p_business IS NULL OR ws.business_id = p_business)
    AND ws.quantity < 0
    AND public._assert_org_member(p_org) IS NULL
  ORDER BY ws.quantity ASC
  LIMIT 500;
$$;

GRANT EXECUTE ON FUNCTION public.list_negative_stock_positions(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------
-- E. Single, org-scoped integrity findings entry point
-- ---------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_accounting_integrity_findings(boolean);

CREATE OR REPLACE FUNCTION public.get_accounting_integrity_findings(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
  _severity text DEFAULT NULL,
  _limit integer DEFAULT 500
)
RETURNS TABLE(
  id uuid, organization_id uuid, business_id uuid, branch_id uuid,
  severity text, finding_code text, finding_title text, finding_detail text,
  entity_type text, entity_id uuid, entity_ref text, evidence jsonb,
  detected_at timestamp with time zone
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH all_findings AS (
    SELECT * FROM public.accounting_integrity_findings
    UNION ALL
    SELECT * FROM public.accounting_integrity_findings_supplemental
    UNION ALL
    SELECT * FROM public.accounting_integrity_findings_stock_adjustments
    UNION ALL
    SELECT * FROM public.accounting_integrity_findings_stock_negative
  )
  SELECT
    f.id, f.organization_id, f.business_id, f.branch_id,
    f.severity, f.finding_code, f.finding_title, f.finding_detail,
    f.entity_type, f.entity_id, f.entity_ref, f.evidence, f.detected_at
  FROM all_findings f
  WHERE f.organization_id = _org_id
    AND public._assert_org_member(_org_id) IS NULL
    AND (_business_id IS NULL OR f.business_id = _business_id)
    AND (_branch_id IS NULL OR f.branch_id = _branch_id OR f.branch_id IS NULL)
    AND (_severity IS NULL OR f.severity = _severity)
  ORDER BY
    CASE f.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
    f.finding_code, f.entity_ref
  LIMIT LEAST(GREATEST(COALESCE(_limit, 500), 1), 5000);
$$;

GRANT EXECUTE ON FUNCTION public.get_accounting_integrity_findings(uuid, uuid, uuid, text, integer) TO authenticated;

-- ---------------------------------------------------------------
-- B. Defensible tie-out
--    Subledger: qty x COALESCE(warehouse AVCO, product cost) per
--               inventory control account (product override first).
--    GL side  : SUM(debit - credit) over POSTED journal lines <= as-of.
-- ---------------------------------------------------------------
DROP FUNCTION IF EXISTS public.reconcile_inventory_subledger_to_gl(uuid);

CREATE OR REPLACE FUNCTION public.reconcile_inventory_subledger_to_gl(
  p_org uuid,
  p_business uuid DEFAULT NULL,
  p_as_of date DEFAULT NULL
)
RETURNS TABLE(
  account_id uuid,
  account_code text,
  account_name text,
  business_id uuid,
  subledger_value numeric,
  gl_closing numeric,
  drift numeric,
  fallback_cost_lines integer,
  zero_cost_lines integer,
  negative_qty_lines integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_as_of date := COALESCE(p_as_of, current_date);
BEGIN
  PERFORM public._assert_org_member(p_org);

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
$$;

GRANT EXECUTE ON FUNCTION public.reconcile_inventory_subledger_to_gl(uuid, uuid, date) TO authenticated;

-- ---------------------------------------------------------------
-- B2. Subledger composition (defend the subledger figure line by line)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_inventory_subledger_composition(
  p_org uuid,
  p_business uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE(
  warehouse_id uuid,
  warehouse_name text,
  product_id uuid,
  product_name text,
  sku text,
  quantity numeric,
  unit_cost numeric,
  cost_basis text,
  value numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ws.warehouse_id,
    w.name,
    ws.product_id,
    p.name,
    p.sku,
    ws.quantity,
    COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0),
    CASE
      WHEN COALESCE(ws.average_cost, 0) <> 0 THEN 'avco'
      WHEN COALESCE(p.cost_price, 0) <> 0 THEN 'product_cost'
      ELSE 'none'
    END,
    ws.quantity * COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0)
  FROM public.warehouse_stock ws
  JOIN public.products p ON p.id = ws.product_id
  LEFT JOIN public.warehouses w ON w.id = ws.warehouse_id
  WHERE ws.organization_id = p_org
    AND (p_business IS NULL OR ws.business_id = p_business)
    AND ws.quantity <> 0
    AND public._assert_org_member(p_org) IS NULL
  ORDER BY abs(ws.quantity * COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0)) DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
$$;

GRANT EXECUTE ON FUNCTION public.list_inventory_subledger_composition(uuid, uuid, integer) TO authenticated;

-- ---------------------------------------------------------------
-- C. Difference explained
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.explain_inventory_gl_drift(
  p_org uuid,
  p_business uuid DEFAULT NULL,
  p_as_of date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_as_of date := COALESCE(p_as_of, current_date);
  v_drift numeric := 0;
  v_missing_je_count integer := 0;
  v_missing_je_value numeric := 0;
  v_zero_cost_qty numeric := 0;
  v_zero_cost_lines integer := 0;
  v_negative_value numeric := 0;
  v_negative_lines integer := 0;
  v_foreign_source numeric := 0;
  v_accounts uuid[];
BEGIN
  PERFORM public._assert_org_member(p_org);

  SELECT COALESCE(SUM(r.drift), 0) INTO v_drift
  FROM public.reconcile_inventory_subledger_to_gl(p_org, p_business, v_as_of) r;

  SELECT array_agg(DISTINCT das.account_id) INTO v_accounts
  FROM public.default_account_settings das
  WHERE das.organization_id = p_org
    AND das.setting_key = 'inventory'
    AND das.account_id IS NOT NULL;

  -- Approved adjustments that moved stock but posted no journal entry
  SELECT COUNT(*), COALESCE(SUM(COALESCE(sa.total_value, 0)), 0)
  INTO v_missing_je_count, v_missing_je_value
  FROM public.stock_adjustments sa
  WHERE sa.organization_id = p_org
    AND (p_business IS NULL OR sa.business_id = p_business)
    AND sa.status = 'approved'
    AND sa.adjustment_date <= v_as_of
    AND NOT EXISTS (
      SELECT 1 FROM public.journal_entries je
      WHERE je.source_type = 'stock_adjustment' AND je.source_id = sa.id
    );

  -- Stock carried at zero cost: real quantity with no valuation
  SELECT COUNT(*), COALESCE(SUM(ws.quantity), 0)
  INTO v_zero_cost_lines, v_zero_cost_qty
  FROM public.warehouse_stock ws
  JOIN public.products p ON p.id = ws.product_id
  WHERE ws.organization_id = p_org
    AND (p_business IS NULL OR ws.business_id = p_business)
    AND ws.quantity <> 0
    AND COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0) = 0;

  -- Negative stock: valuation the subledger should not contain
  SELECT COUNT(*), COALESCE(SUM(ws.quantity * COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0)), 0)
  INTO v_negative_lines, v_negative_value
  FROM public.warehouse_stock ws
  JOIN public.products p ON p.id = ws.product_id
  WHERE ws.organization_id = p_org
    AND (p_business IS NULL OR ws.business_id = p_business)
    AND ws.quantity < 0;

  -- Postings into an inventory control account from a non-inventory source
  IF v_accounts IS NOT NULL THEN
    SELECT COALESCE(SUM(COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)), 0)
    INTO v_foreign_source
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.organization_id = p_org
      AND je.status = 'posted'
      AND je.entry_date <= v_as_of
      AND (p_business IS NULL OR je.business_id = p_business)
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
      jsonb_build_object('code', 'missing_adjustment_journals', 'label', 'Approved adjustments with no journal entry',
                         'count', v_missing_je_count, 'amount', v_missing_je_value),
      jsonb_build_object('code', 'zero_cost_stock', 'label', 'Stock on hand carried at zero cost',
                         'count', v_zero_cost_lines, 'amount', 0, 'quantity', v_zero_cost_qty),
      jsonb_build_object('code', 'negative_stock', 'label', 'Negative stock included in the subledger',
                         'count', v_negative_lines, 'amount', v_negative_value),
      jsonb_build_object('code', 'non_inventory_postings', 'label', 'Postings into the inventory account from non-inventory sources',
                         'count', NULL, 'amount', v_foreign_source)
    ),
    'unexplained', v_drift - v_missing_je_value - v_negative_value + v_foreign_source
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.explain_inventory_gl_drift(uuid, uuid, date) TO authenticated;

-- ---------------------------------------------------------------
-- D. Safe remediation: explicit company, dry run, period lock,
--    per-company idempotency, no history mutation.
-- ---------------------------------------------------------------
DROP FUNCTION IF EXISTS public.backfill_opening_inventory_gl(uuid);

CREATE OR REPLACE FUNCTION public.backfill_opening_inventory_gl(
  p_org uuid,
  p_business uuid DEFAULT NULL,
  p_as_of date DEFAULT NULL,
  p_dry_run boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
                              'dry_run', p_dry_run);
  END IF;

  IF public.is_period_locked(p_org, v_business, v_entry_date) THEN
    IF p_dry_run THEN
      RETURN jsonb_build_object('skipped', true, 'reason', 'period_locked',
                                'entry_date', v_entry_date, 'total', v_total, 'dry_run', true);
    END IF;
    RAISE EXCEPTION 'Accounting period containing % is locked', v_entry_date;
  END IF;

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'dry_run', true,
      'business_id', v_business,
      'entry_date', v_entry_date,
      'total_posted', v_total,
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
        'description', 'Opening inventory at cost'),
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
    'entry_date', v_entry_date
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.backfill_opening_inventory_gl(uuid, uuid, date, boolean) TO authenticated;