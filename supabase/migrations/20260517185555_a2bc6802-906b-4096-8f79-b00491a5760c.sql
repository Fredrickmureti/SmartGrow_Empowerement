DROP FUNCTION IF EXISTS public.ensure_inventory_gl_accounts(uuid, uuid);

CREATE OR REPLACE FUNCTION public.ensure_inventory_gl_accounts(
  _org_id uuid,
  _business_id uuid
)
RETURNS TABLE (
  inventory_account_id uuid,
  adjustment_account_id uuid,
  cogs_account_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_inv  uuid;
  v_adj  uuid;
  v_cogs uuid;
  v_code text;
  v_clash int;
BEGIN
  IF _org_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'ensure_inventory_gl_accounts requires org and business ids';
  END IF;

  -- 1. Inventory asset
  SELECT account_id INTO v_inv
    FROM default_account_settings
   WHERE organization_id=_org_id AND business_id=_business_id AND setting_key='inventory'
   LIMIT 1;

  IF v_inv IS NULL THEN
    SELECT id INTO v_inv FROM accounts
     WHERE organization_id=_org_id AND business_id=_business_id
       AND detail_type='inventory' AND coalesce(is_header,false)=false AND is_active=true
     ORDER BY code LIMIT 1;
  END IF;

  IF v_inv IS NULL THEN
    v_code := '1130';
    SELECT count(*) INTO v_clash FROM accounts
     WHERE organization_id=_org_id AND business_id=_business_id AND code=v_code;
    IF v_clash > 0 THEN v_code := '1130-SYS'; END IF;
    INSERT INTO accounts (organization_id, business_id, account_type, detail_type, code, name, description, is_system, is_active, opening_balance, current_balance)
    VALUES (_org_id, _business_id, 'asset', 'inventory', v_code, 'Inventory', 'System inventory asset account (auto-provisioned)', true, true, 0, 0)
    RETURNING id INTO v_inv;
  END IF;

  INSERT INTO default_account_settings (organization_id, business_id, branch_id, setting_key, account_id)
  VALUES (_org_id, _business_id, NULL, 'inventory', v_inv)
  ON CONFLICT (organization_id, business_id, branch_id, setting_key)
  DO UPDATE SET account_id = EXCLUDED.account_id
   WHERE default_account_settings.account_id IS NULL;

  -- 2. Inventory adjustment — MUST land on a registry-eligible detail_type
  --    ('other_business_expenses','cost_of_sales_other','other_expense').
  SELECT account_id INTO v_adj
    FROM default_account_settings
   WHERE organization_id=_org_id AND business_id=_business_id AND setting_key='inventory_adjustment'
   LIMIT 1;

  IF v_adj IS NULL THEN
    SELECT id INTO v_adj FROM accounts
     WHERE organization_id=_org_id AND business_id=_business_id
       AND detail_type IN ('cost_of_sales_other','other_business_expenses','other_expense')
       AND coalesce(is_header,false)=false AND is_active=true
       AND (name ILIKE '%inventory%adjust%' OR name ILIKE '%shrinkage%' OR name ILIKE '%inventory%write%')
     ORDER BY CASE detail_type WHEN 'other_business_expenses' THEN 1 WHEN 'cost_of_sales_other' THEN 2 WHEN 'other_expense' THEN 3 ELSE 4 END, code
     LIMIT 1;
  END IF;

  IF v_adj IS NULL THEN
    SELECT id INTO v_adj FROM accounts
     WHERE organization_id=_org_id AND business_id=_business_id
       AND code='7000' AND coalesce(is_header,false)=false AND is_active=true
       AND detail_type IN ('cost_of_sales_other','other_business_expenses','other_expense')
     LIMIT 1;
  END IF;

  IF v_adj IS NULL THEN
    SELECT id INTO v_adj FROM accounts
     WHERE organization_id=_org_id AND business_id=_business_id
       AND detail_type IN ('cost_of_sales_other','other_business_expenses','other_expense')
       AND coalesce(is_header,false)=false AND is_active=true
     ORDER BY CASE detail_type WHEN 'other_business_expenses' THEN 1 WHEN 'cost_of_sales_other' THEN 2 WHEN 'other_expense' THEN 3 ELSE 4 END, code
     LIMIT 1;
  END IF;

  IF v_adj IS NULL THEN
    v_code := '5150';
    SELECT count(*) INTO v_clash FROM accounts
     WHERE organization_id=_org_id AND business_id=_business_id AND code=v_code;
    IF v_clash > 0 THEN v_code := '5150-SYS'; END IF;
    INSERT INTO accounts (organization_id, business_id, account_type, detail_type, code, name, description, is_system, is_active, opening_balance, current_balance)
    VALUES (_org_id, _business_id, 'expense', 'other_business_expenses', v_code, 'Inventory Adjustment', 'System inventory adjustment / shrinkage account (auto-provisioned)', true, true, 0, 0)
    RETURNING id INTO v_adj;
  END IF;

  INSERT INTO default_account_settings (organization_id, business_id, branch_id, setting_key, account_id)
  VALUES (_org_id, _business_id, NULL, 'inventory_adjustment', v_adj)
  ON CONFLICT (organization_id, business_id, branch_id, setting_key)
  DO UPDATE SET account_id = EXCLUDED.account_id
   WHERE default_account_settings.account_id IS NULL;

  -- 3. COGS
  SELECT account_id INTO v_cogs
    FROM default_account_settings
   WHERE organization_id=_org_id AND business_id=_business_id AND setting_key='cogs'
   LIMIT 1;

  IF v_cogs IS NULL THEN
    SELECT id INTO v_cogs FROM accounts
     WHERE organization_id=_org_id AND business_id=_business_id
       AND detail_type='cost_of_goods_sold' AND coalesce(is_header,false)=false AND is_active=true
     ORDER BY code LIMIT 1;
  END IF;

  IF v_cogs IS NULL THEN
    v_code := '5100';
    SELECT count(*) INTO v_clash FROM accounts
     WHERE organization_id=_org_id AND business_id=_business_id AND code=v_code;
    IF v_clash > 0 THEN v_code := '5100-SYS'; END IF;
    INSERT INTO accounts (organization_id, business_id, account_type, detail_type, code, name, description, is_system, is_active, opening_balance, current_balance)
    VALUES (_org_id, _business_id, 'expense', 'cost_of_goods_sold', v_code, 'Cost of Goods Sold', 'System COGS account (auto-provisioned)', true, true, 0, 0)
    RETURNING id INTO v_cogs;
  END IF;

  INSERT INTO default_account_settings (organization_id, business_id, branch_id, setting_key, account_id)
  VALUES (_org_id, _business_id, NULL, 'cogs', v_cogs)
  ON CONFLICT (organization_id, business_id, branch_id, setting_key)
  DO UPDATE SET account_id = EXCLUDED.account_id
   WHERE default_account_settings.account_id IS NULL;

  inventory_account_id  := v_inv;
  adjustment_account_id := v_adj;
  cogs_account_id       := v_cogs;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_inventory_gl_accounts(uuid, uuid) TO authenticated, service_role;

-- Backfill existing tenants idempotently.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT organization_id, business_id
      FROM default_account_settings
     WHERE setting_key='inventory' AND business_id IS NOT NULL
  LOOP
    PERFORM public.ensure_inventory_gl_accounts(r.organization_id, r.business_id);
  END LOOP;
END $$;
