
-- ============================================================
-- Inventory subledger ↔ GL reconciliation primitives
-- ============================================================

-- Helper: caller-org guard
CREATE OR REPLACE FUNCTION public._assert_org_member(p_org uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_users
    WHERE organization_id = p_org AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of organization %', p_org USING ERRCODE = '42501';
  END IF;
END;
$$;

-- ---------------------------------------------------------------
-- 1. post_stock_adjustment_gl
-- Posts a balanced JE for a stock adjustment.
-- p_mode: 'opening' (CR Opening Balance Equity) | 'revaluation' (CR/DR Inventory Adjustment expense)
-- Idempotent on (source_type='stock_adjustment', source_id=p_adjustment_id).
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_stock_adjustment_gl(
  p_adjustment_id uuid,
  p_mode text DEFAULT 'opening'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_business uuid;
  v_date date;
  v_number text;
  v_inv_account uuid;
  v_counter_account uuid;
  v_existing uuid;
  v_je_id uuid;
  v_total_value numeric := 0;
  v_dr numeric := 0;
  v_cr numeric := 0;
BEGIN
  IF p_mode NOT IN ('opening','revaluation') THEN
    RAISE EXCEPTION 'Invalid mode %', p_mode;
  END IF;

  SELECT organization_id, business_id, adjustment_date, adjustment_number
    INTO v_org, v_business, v_date, v_number
  FROM public.stock_adjustments WHERE id = p_adjustment_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Adjustment % not found', p_adjustment_id; END IF;

  PERFORM public._assert_org_member(v_org);

  -- Idempotency
  SELECT id INTO v_existing FROM public.journal_entries
    WHERE organization_id = v_org
      AND source_type = 'stock_adjustment'
      AND source_id = p_adjustment_id
    LIMIT 1;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  -- Resolve accounts
  SELECT account_id INTO v_inv_account FROM public.default_account_settings
    WHERE organization_id = v_org AND setting_key = 'inventory' LIMIT 1;
  IF v_inv_account IS NULL THEN
    RAISE EXCEPTION 'Inventory default account is not configured';
  END IF;

  IF p_mode = 'opening' THEN
    SELECT account_id INTO v_counter_account FROM public.default_account_settings
      WHERE organization_id = v_org AND setting_key = 'opening_balance_equity' LIMIT 1;
    IF v_counter_account IS NULL THEN
      RAISE EXCEPTION 'Opening Balance Equity default account is not configured';
    END IF;
  ELSE
    -- revaluation → Inventory Adjustment expense; fall back to COGS if not configured
    SELECT account_id INTO v_counter_account FROM public.default_account_settings
      WHERE organization_id = v_org AND setting_key IN ('inventory_adjustment','cogs')
      ORDER BY CASE setting_key WHEN 'inventory_adjustment' THEN 0 ELSE 1 END LIMIT 1;
    IF v_counter_account IS NULL THEN
      RAISE EXCEPTION 'Inventory Adjustment / COGS default account is not configured';
    END IF;
  END IF;

  -- Compute net value from adjustment items.
  -- Use coalesce(unit_cost, products.cost_price) so opening adjustments saved with unit_cost=0
  -- but a real cost on the product still produce the correct journal value.
  SELECT COALESCE(SUM(sai.quantity_adjustment * COALESCE(NULLIF(sai.unit_cost,0), p.cost_price, 0)), 0)
    INTO v_total_value
  FROM public.stock_adjustment_items sai
  JOIN public.products p ON p.id = sai.product_id
  WHERE sai.adjustment_id = p_adjustment_id;

  IF v_total_value = 0 THEN
    RAISE EXCEPTION 'Stock adjustment has zero value — refusing to post empty journal';
  END IF;

  -- Sign: positive net → inventory increases → DR Inventory / CR counter; negative reverses.
  IF v_total_value > 0 THEN
    v_dr := v_total_value; v_cr := v_total_value;
  ELSE
    v_dr := -v_total_value; v_cr := -v_total_value;
  END IF;

  INSERT INTO public.journal_entries (
    organization_id, business_id, entry_date, description, status,
    source_type, source_id, total_debit, total_credit, posted_at, posted_by,
    is_opening_entry
  ) VALUES (
    v_org, v_business, v_date,
    CASE WHEN p_mode='opening' THEN 'Opening Inventory — ' ELSE 'Inventory Revaluation — ' END || COALESCE(v_number,''),
    'posted', 'stock_adjustment', p_adjustment_id,
    v_dr, v_cr, now(), auth.uid(),
    p_mode = 'opening'
  ) RETURNING id INTO v_je_id;

  IF v_total_value > 0 THEN
    INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
    VALUES
      (v_je_id, v_inv_account, v_dr, 0, 'Inventory increase', 0),
      (v_je_id, v_counter_account, 0, v_cr,
       CASE WHEN p_mode='opening' THEN 'Opening Balance Equity' ELSE 'Inventory Adjustment' END, 1);
  ELSE
    INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
    VALUES
      (v_je_id, v_counter_account, v_dr, 0,
       CASE WHEN p_mode='opening' THEN 'Opening Balance Equity' ELSE 'Inventory Adjustment' END, 0),
      (v_je_id, v_inv_account, 0, v_cr, 'Inventory decrease', 1);
  END IF;

  RETURN v_je_id;
END;
$$;

-- ---------------------------------------------------------------
-- 2. reconcile_inventory_subledger_to_gl
-- Returns subledger value, GL closing, drift for the inventory control account.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_inventory_subledger_to_gl(p_org uuid)
RETURNS TABLE (
  account_id uuid,
  account_code text,
  account_name text,
  subledger_value numeric,
  gl_closing numeric,
  drift numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv_account uuid;
  v_subledger numeric := 0;
BEGIN
  PERFORM public._assert_org_member(p_org);

  SELECT das.account_id INTO v_inv_account
  FROM public.default_account_settings das
  WHERE das.organization_id = p_org AND das.setting_key = 'inventory' LIMIT 1;

  IF v_inv_account IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(ws.quantity * COALESCE(p.cost_price,0)), 0) INTO v_subledger
  FROM public.warehouse_stock ws
  JOIN public.products p ON p.id = ws.product_id
  WHERE p.organization_id = p_org;

  RETURN QUERY
  SELECT a.id, a.code, a.name,
         v_subledger,
         COALESCE(a.current_balance, 0) AS gl_closing,
         v_subledger - COALESCE(a.current_balance, 0) AS drift
  FROM public.accounts a
  WHERE a.id = v_inv_account;
END;
$$;

-- ---------------------------------------------------------------
-- 3. backfill_opening_inventory_gl
-- Detects zero-cost opening adjustments (unit_cost=0 while product.cost_price > 0),
-- posts ONE consolidated Opening Inventory JE, back-stamps unit_cost on the rows.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backfill_opening_inventory_gl(p_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv_account uuid;
  v_obe_account uuid;
  v_business uuid;
  v_total numeric := 0;
  v_first_date date;
  v_je_id uuid;
  v_existing uuid;
BEGIN
  PERFORM public._assert_org_member(p_org);

  -- Skip when an opening inventory JE already exists for this org
  SELECT id INTO v_existing FROM public.journal_entries
    WHERE organization_id = p_org
      AND is_opening_entry = true
      AND source_type = 'stock_adjustment_backfill'
    LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'opening_already_posted', 'journal_entry_id', v_existing);
  END IF;

  SELECT account_id INTO v_inv_account FROM public.default_account_settings
    WHERE organization_id = p_org AND setting_key = 'inventory' LIMIT 1;
  SELECT account_id INTO v_obe_account FROM public.default_account_settings
    WHERE organization_id = p_org AND setting_key = 'opening_balance_equity' LIMIT 1;

  IF v_inv_account IS NULL OR v_obe_account IS NULL THEN
    RAISE EXCEPTION 'Inventory or Opening Balance Equity default accounts not configured';
  END IF;

  SELECT
    COALESCE(SUM(sm.quantity * COALESCE(p.cost_price, 0)), 0),
    MIN(sm.created_at)::date
  INTO v_total, v_first_date
  FROM public.stock_movements sm
  JOIN public.products p ON p.id = sm.product_id
  WHERE sm.organization_id = p_org
    AND sm.movement_type = 'adjustment'
    AND COALESCE(sm.unit_cost, 0) = 0
    AND COALESCE(p.cost_price, 0) > 0
    AND sm.quantity > 0;

  IF v_total = 0 THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'no_zero_cost_opening_movements');
  END IF;

  -- Pick any business id from the org for the entry header
  SELECT id INTO v_business FROM public.businesses WHERE organization_id = p_org LIMIT 1;

  INSERT INTO public.journal_entries (
    organization_id, business_id, entry_date, description, status,
    source_type, source_id, total_debit, total_credit, posted_at, posted_by,
    is_opening_entry
  ) VALUES (
    p_org, v_business, COALESCE(v_first_date, current_date),
    'Opening Inventory — backfill from zero-cost stock adjustments',
    'posted', 'stock_adjustment_backfill', NULL,
    v_total, v_total, now(), auth.uid(), true
  ) RETURNING id INTO v_je_id;

  INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
  VALUES
    (v_je_id, v_inv_account, v_total, 0, 'Opening inventory at cost', 0),
    (v_je_id, v_obe_account, 0, v_total, 'Opening Balance Equity', 1);

  -- Back-stamp unit_cost for audit trail
  UPDATE public.stock_movements sm
  SET unit_cost = p.cost_price
  FROM public.products p
  WHERE sm.product_id = p.id
    AND sm.organization_id = p_org
    AND sm.movement_type = 'adjustment'
    AND COALESCE(sm.unit_cost, 0) = 0
    AND COALESCE(p.cost_price, 0) > 0
    AND sm.quantity > 0;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_je_id,
    'total_posted', v_total,
    'entry_date', v_first_date
  );
END;
$$;

-- ---------------------------------------------------------------
-- 4. detect_negative_asset_findings
-- Inserts critical integrity findings for any asset account < 0
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.detect_negative_asset_findings(p_org uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  PERFORM public._assert_org_member(p_org);

  INSERT INTO public.accounting_integrity_findings (
    organization_id, severity, finding_code, finding_title, finding_detail,
    entity_type, entity_id, entity_ref, evidence
  )
  SELECT
    p_org, 'critical', 'NEGATIVE_ASSET_BALANCE',
    'Asset account has negative balance',
    'Account "' || a.name || '" (' || a.code || ') has a closing balance of '
      || a.current_balance || '. Assets cannot be negative in correct accounting.',
    'account', a.id, a.code,
    jsonb_build_object('current_balance', a.current_balance, 'opening_balance', a.opening_balance, 'detail_type', a.detail_type)
  FROM public.accounts a
  WHERE a.organization_id = p_org
    AND a.account_type = 'asset'
    AND COALESCE(a.current_balance, 0) < 0
    AND NOT EXISTS (
      SELECT 1 FROM public.accounting_integrity_findings f
      WHERE f.organization_id = p_org
        AND f.finding_code = 'NEGATIVE_ASSET_BALANCE'
        AND f.entity_id = a.id
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.post_stock_adjustment_gl(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_inventory_subledger_to_gl(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_opening_inventory_gl(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.detect_negative_asset_findings(uuid) TO authenticated;
