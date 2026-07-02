
-- =====================================================================
-- Inventory GL auto-provisioning + readiness
-- Fixes: "Cannot post stock adjustment to GL: missing inventory or
--        adjustment account for company <uuid>" on fresh tenants.
-- =====================================================================

-- Helper: returns (inventory_asset_id, inventory_adjustment_id) for the
-- given org+business, creating system accounts + default_account_settings
-- mappings as needed. Idempotent and SECURITY DEFINER so it can run inside
-- the existing approval RPC.
CREATE OR REPLACE FUNCTION public.ensure_inventory_gl_accounts(
  _org_id uuid,
  _business_id uuid
)
RETURNS TABLE (inventory_account_id uuid, adjustment_account_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_inv uuid;
  v_adj uuid;
  v_code text;
  v_clash int;
BEGIN
  IF _org_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'ensure_inventory_gl_accounts requires org and business ids';
  END IF;

  -- 1. Inventory asset: prefer default_account_settings mapping, then
  --    detail_type lookup. Auto-provision if neither exists.
  SELECT account_id INTO v_inv
    FROM default_account_settings
   WHERE organization_id = _org_id
     AND business_id     = _business_id
     AND setting_key     = 'inventory_asset'
   LIMIT 1;

  IF v_inv IS NULL THEN
    SELECT id INTO v_inv
      FROM accounts
     WHERE organization_id = _org_id
       AND business_id     = _business_id
       AND detail_type     = 'inventory'
       AND is_active       = true
     ORDER BY code
     LIMIT 1;
  END IF;

  IF v_inv IS NULL THEN
    -- Provision 1130 Inventory (or 1130-SYS if 1130 is taken)
    v_code := '1130';
    SELECT count(*) INTO v_clash
      FROM accounts
     WHERE organization_id = _org_id
       AND business_id     = _business_id
       AND code            = v_code;
    IF v_clash > 0 THEN v_code := '1130-SYS'; END IF;

    INSERT INTO accounts (
      organization_id, business_id, account_type, detail_type,
      code, name, description, is_system, is_active,
      opening_balance, current_balance
    ) VALUES (
      _org_id, _business_id, 'asset', 'inventory',
      v_code, 'Inventory',
      'System inventory asset account (auto-provisioned)',
      true, true, 0, 0
    ) RETURNING id INTO v_inv;
  END IF;

  -- Upsert mapping so subsequent posts skip the lookup.
  INSERT INTO default_account_settings (
    organization_id, business_id, branch_id, setting_key, account_id
  ) VALUES (_org_id, _business_id, NULL, 'inventory_asset', v_inv)
  ON CONFLICT (organization_id, business_id, branch_id, setting_key)
  DO UPDATE SET account_id = EXCLUDED.account_id
   WHERE default_account_settings.account_id IS NULL;

  -- 2. Inventory adjustment expense: same resolution.
  SELECT account_id INTO v_adj
    FROM default_account_settings
   WHERE organization_id = _org_id
     AND business_id     = _business_id
     AND setting_key     = 'inventory_adjustment'
   LIMIT 1;

  IF v_adj IS NULL THEN
    SELECT id INTO v_adj
      FROM accounts
     WHERE organization_id = _org_id
       AND business_id     = _business_id
       AND detail_type     = 'inventory_adjustment'
       AND is_active       = true
     ORDER BY code
     LIMIT 1;
  END IF;

  IF v_adj IS NULL THEN
    -- Legacy fallback: operating_expenses, kept so existing tenants that
    -- relied on it continue to behave the same way.
    SELECT id INTO v_adj
      FROM accounts
     WHERE organization_id = _org_id
       AND business_id     = _business_id
       AND detail_type     = 'operating_expenses'
       AND is_active       = true
     ORDER BY code
     LIMIT 1;
  END IF;

  IF v_adj IS NULL THEN
    v_code := '5100';
    SELECT count(*) INTO v_clash
      FROM accounts
     WHERE organization_id = _org_id
       AND business_id     = _business_id
       AND code            = v_code;
    IF v_clash > 0 THEN v_code := '5100-SYS'; END IF;

    INSERT INTO accounts (
      organization_id, business_id, account_type, detail_type,
      code, name, description, is_system, is_active,
      opening_balance, current_balance
    ) VALUES (
      _org_id, _business_id, 'expense', 'inventory_adjustment',
      v_code, 'Inventory Adjustment',
      'System inventory adjustment / shrinkage account (auto-provisioned)',
      true, true, 0, 0
    ) RETURNING id INTO v_adj;
  END IF;

  INSERT INTO default_account_settings (
    organization_id, business_id, branch_id, setting_key, account_id
  ) VALUES (_org_id, _business_id, NULL, 'inventory_adjustment', v_adj)
  ON CONFLICT (organization_id, business_id, branch_id, setting_key)
  DO UPDATE SET account_id = EXCLUDED.account_id
   WHERE default_account_settings.account_id IS NULL;

  inventory_account_id  := v_inv;
  adjustment_account_id := v_adj;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_inventory_gl_accounts(uuid, uuid)
  TO authenticated, service_role;


-- Replace approve_stock_adjustment_atomic with the version that uses the
-- helper instead of raising. Body is identical to the existing migration
-- (20260429205810_*) except the account-resolution block.
CREATE OR REPLACE FUNCTION public.approve_stock_adjustment_atomic(
  p_adjustment_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_adjustment RECORD;
  v_item RECORD;
  v_org_id UUID;
  v_biz_id UUID;
  v_inventory_account_id UUID;
  v_adjustment_account_id UUID;
  v_total_positive numeric := 0;
  v_total_negative numeric := 0;
  v_journal_id UUID;
  v_cost numeric;
BEGIN
  SELECT id, organization_id, business_id, status
    INTO v_adjustment
    FROM stock_adjustments
   WHERE id = p_adjustment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment not found');
  END IF;

  IF v_adjustment.status = 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment is already approved');
  END IF;

  IF v_adjustment.status NOT IN ('draft', 'pending_approval') THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment cannot be approved (current status: ' || v_adjustment.status || ')');
  END IF;

  v_org_id := v_adjustment.organization_id;
  v_biz_id := v_adjustment.business_id;

  IF v_biz_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment has no business_id; cannot post to GL');
  END IF;

  FOR v_item IN
    SELECT * FROM stock_adjustment_items WHERE adjustment_id = p_adjustment_id
  LOOP
    INSERT INTO stock_movements (
      organization_id, business_id, product_id, movement_type,
      quantity, unit_cost, warehouse_id,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_org_id, v_biz_id, v_item.product_id, 'adjustment',
      v_item.quantity_adjustment, v_item.unit_cost, v_item.warehouse_id,
      'stock_adjustment', p_adjustment_id, v_item.notes, p_user_id
    );

    v_cost := ABS(v_item.quantity_adjustment) * COALESCE(v_item.unit_cost, 0);
    IF v_cost > 0 THEN
      IF v_item.quantity_adjustment > 0 THEN
        v_total_positive := v_total_positive + v_cost;
      ELSE
        v_total_negative := v_total_negative + v_cost;
      END IF;
    END IF;
  END LOOP;

  UPDATE stock_adjustments
     SET status = 'approved',
         approved_by = p_user_id,
         approved_at = now()
   WHERE id = p_adjustment_id;

  UPDATE approval_rule_logs
     SET status = 'approved',
         approved_by = p_user_id,
         approved_at = now()
   WHERE entity_type = 'stock_adjustment'
     AND entity_id = p_adjustment_id::text
     AND action_name = 'apply'
     AND status = 'pending';

  IF (v_total_positive > 0 OR v_total_negative > 0) THEN
    -- Resolve through default_account_settings → detail_type → auto-provision.
    SELECT inventory_account_id, adjustment_account_id
      INTO v_inventory_account_id, v_adjustment_account_id
      FROM public.ensure_inventory_gl_accounts(v_org_id, v_biz_id);

    IF v_inventory_account_id IS NULL OR v_adjustment_account_id IS NULL THEN
      RAISE EXCEPTION 'Cannot post stock adjustment to GL: failed to provision inventory or adjustment account for company %', v_biz_id;
    END IF;

    INSERT INTO journal_entries (
      organization_id, business_id, entry_date, reference, description,
      source_type, source_id, status, created_by
    ) VALUES (
      v_org_id, v_biz_id, CURRENT_DATE,
      'ADJ-' || LEFT(p_adjustment_id::text, 8),
      'Stock adjustment approved',
      'stock_adjustment', p_adjustment_id,
      'posted', p_user_id
    ) RETURNING id INTO v_journal_id;

    IF v_total_positive > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_amount, credit_amount, description)
      VALUES
        (v_journal_id, v_inventory_account_id,  v_total_positive, 0, 'Stock Adjustment - Inventory Increase'),
        (v_journal_id, v_adjustment_account_id, 0, v_total_positive, 'Stock Adjustment - Inventory Increase Offset');
    END IF;

    IF v_total_negative > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_amount, credit_amount, description)
      VALUES
        (v_journal_id, v_adjustment_account_id, v_total_negative, 0, 'Stock Adjustment - Shrinkage/Loss'),
        (v_journal_id, v_inventory_account_id, 0, v_total_negative, 'Stock Adjustment - Inventory Reduction');
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'adjustment_id', p_adjustment_id,
                            'gl_posted', v_journal_id IS NOT NULL,
                            'status', 'approved');
END;
$function$;


-- Readiness function (informational; mirrors payroll_gl_readiness shape)
CREATE OR REPLACE FUNCTION public.inventory_gl_readiness(
  _org_id uuid,
  _business_id uuid
)
RETURNS TABLE (
  setting_key text,
  label text,
  required_account_type text,
  is_mapped boolean,
  suggested_account_id uuid,
  suggested_account_label text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH required AS (
    SELECT 'inventory_asset'::text       AS setting_key,
           'Inventory Asset'::text       AS label,
           'asset'::text                 AS required_account_type,
           'inventory'::text             AS fallback_detail_type
    UNION ALL
    SELECT 'inventory_adjustment',
           'Inventory Adjustment / Shrinkage',
           'expense',
           'inventory_adjustment'
  )
  SELECT
    r.setting_key,
    r.label,
    r.required_account_type,
    (m.account_id IS NOT NULL) AS is_mapped,
    COALESCE(m.account_id, s.id) AS suggested_account_id,
    COALESCE(
      (SELECT code || ' ' || name FROM accounts WHERE id = m.account_id),
      (SELECT code || ' ' || name FROM accounts WHERE id = s.id)
    ) AS suggested_account_label
  FROM required r
  LEFT JOIN default_account_settings m
    ON m.organization_id = _org_id
   AND m.business_id     = _business_id
   AND m.setting_key     = r.setting_key
  LEFT JOIN LATERAL (
    SELECT id FROM accounts
     WHERE organization_id = _org_id
       AND business_id     = _business_id
       AND detail_type     = r.fallback_detail_type
       AND is_active       = true
     ORDER BY code LIMIT 1
  ) s ON true;
$$;

GRANT EXECUTE ON FUNCTION public.inventory_gl_readiness(uuid, uuid)
  TO authenticated, service_role;
