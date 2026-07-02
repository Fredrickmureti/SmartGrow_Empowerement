-- =====================================================================
-- Inventory role-key canonicalization
-- Fix: ensure_inventory_gl_accounts wrote default_account_settings rows
-- with setting_key='inventory_asset', which is not in system_account_roles
-- (the canonical key is 'inventory'). The validate_default_account_setting
-- trigger correctly rejected those writes, breaking opening-stock posting
-- for fresh tenants. Align the helper + readiness function on the canonical
-- key, alias the legacy spelling, and backfill any stray rows.
-- =====================================================================

-- 1. canonicalize_role_key: absorb the legacy 'inventory_asset' spelling.
CREATE OR REPLACE FUNCTION public.canonicalize_role_key(_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(coalesce(_key, ''))
    WHEN 'cost_of_goods_sold'      THEN 'cogs'
    WHEN 'sales_tax_payable'       THEN 'output_tax'
    WHEN 'vat_payable'             THEN 'output_tax'
    WHEN 'purchase_tax_receivable' THEN 'input_tax'
    WHEN 'vat_receivable'          THEN 'input_tax'
    WHEN 'pos_cash'                THEN 'cash'
    WHEN 'pos_clearing'            THEN 'clearing_pos'
    WHEN 'undeposited_funds'       THEN 'clearing_undeposited_funds'
    WHEN 'card_clearing'           THEN 'credit_card_clearing'
    WHEN 'inventory_asset'         THEN 'inventory'
    ELSE lower(_key)
  END;
$$;

GRANT EXECUTE ON FUNCTION public.canonicalize_role_key(text) TO authenticated, anon, service_role;

-- 2. ensure_inventory_gl_accounts: speak canonical 'inventory' / 'inventory_adjustment'.
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

  -- Inventory asset: canonical setting_key='inventory'.
  SELECT account_id INTO v_inv
    FROM default_account_settings
   WHERE organization_id = _org_id
     AND business_id     = _business_id
     AND setting_key     = 'inventory'
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

  INSERT INTO default_account_settings (
    organization_id, business_id, branch_id, setting_key, account_id
  ) VALUES (_org_id, _business_id, NULL, 'inventory', v_inv)
  ON CONFLICT (organization_id, business_id, branch_id, setting_key)
  DO UPDATE SET account_id = EXCLUDED.account_id
   WHERE default_account_settings.account_id IS NULL;

  -- Inventory adjustment expense.
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

-- 3. inventory_gl_readiness: emit canonical setting_key='inventory'.
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
    SELECT 'inventory'::text             AS setting_key,
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

-- 4. Backfill: collapse any legacy 'inventory_asset' rows onto canonical 'inventory'.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM default_account_settings WHERE setting_key = 'inventory_asset'
  LOOP
    INSERT INTO default_account_settings (
      organization_id, business_id, branch_id, setting_key, account_id
    ) VALUES (
      r.organization_id, r.business_id, r.branch_id, 'inventory', r.account_id
    )
    ON CONFLICT (organization_id, business_id, branch_id, setting_key)
    DO UPDATE SET account_id = COALESCE(default_account_settings.account_id, EXCLUDED.account_id);

    DELETE FROM default_account_settings WHERE id = r.id;
  END LOOP;
END $$;