-- =====================================================================
-- Wave 7 — Inventory adjustment GL provisioning + Opening Balance Equity
-- Corrected: account_detail_type_catalog.display_label is NOT NULL.
-- =====================================================================

-- 1. Register missing detail type with required display_label.
INSERT INTO public.account_detail_type_catalog (account_type, detail_type, display_label, description)
VALUES ('income', 'other_business_income', 'Other Business Income',
        'Miscellaneous business income such as inventory overages and found stock.')
ON CONFLICT (detail_type) DO NOTHING;

-- 2. Register the four GL roles used by the inventory adjustment engine.
INSERT INTO public.system_account_roles (role_key, label, description, required_account_type, is_mandatory, category, sort_order)
VALUES
  ('inventory_shrinkage_expense', 'Inventory Shrinkage / Damage / Write-off',
   'Expense account hit when inventory is shrunk, damaged or written off via a stock adjustment.',
   'expense', false, 'inventory', 110),
  ('inventory_overage_income',    'Inventory Overage / Found Stock',
   'Income account hit when a positive stock adjustment records found / over-stock.',
   'income',  false, 'inventory', 111),
  ('inventory_revaluation',       'Inventory Revaluation',
   'P&L account hit when a stock adjustment revalues existing inventory.',
   'expense', false, 'inventory', 112),
  ('opening_balance_equity',      'Opening Balance Equity',
   'Equity account used as the contra side for opening balances (stock, AR, AP, cash).',
   'equity',  false, 'equity',    200)
ON CONFLICT (role_key) DO NOTHING;

-- 3. Eligibility entries so validate_default_account_setting accepts auto-provisioned accounts.
INSERT INTO public.account_role_eligibility (role_key, account_type, detail_type, priority) VALUES
  ('inventory_shrinkage_expense', 'expense', 'other_business_expenses', 1),
  ('inventory_shrinkage_expense', 'expense', 'other_expense',           2),
  ('inventory_shrinkage_expense', 'expense', 'cost_of_sales_other',     3),
  ('inventory_overage_income',    'income',  'other_business_income',   1),
  ('inventory_overage_income',    'income',  'other_income',            2),
  ('inventory_revaluation',       'expense', 'other_business_expenses', 1),
  ('inventory_revaluation',       'expense', 'other_expense',           2),
  ('opening_balance_equity',      'equity',  'opening_balance_equity',  1),
  ('opening_balance_equity',      'equity',  'retained_earnings',       2),
  ('opening_balance_equity',      'equity',  'owners_equity',           3),
  ('opening_balance_equity',      'equity',  'common_stock',            4)
ON CONFLICT DO NOTHING;

-- 4. Idempotent provisioner for Opening Balance Equity.
CREATE OR REPLACE FUNCTION public.ensure_opening_balance_equity_account(
  _org_id uuid,
  _business_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_acc uuid;
  v_code text;
  v_clash int;
BEGIN
  IF _org_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'ensure_opening_balance_equity_account requires org and business ids';
  END IF;

  SELECT account_id INTO v_acc
    FROM public.default_account_settings
   WHERE organization_id=_org_id
     AND business_id=_business_id
     AND setting_key='opening_balance_equity'
   LIMIT 1;
  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;

  SELECT a.id INTO v_acc FROM public.accounts a
   WHERE a.organization_id=_org_id AND a.business_id=_business_id
     AND a.account_type='equity'
     AND coalesce(a.is_header,false)=false
     AND coalesce(a.is_active,true)=true
     AND (a.detail_type='opening_balance_equity' OR a.name ILIKE '%opening%balance%equity%')
   ORDER BY CASE WHEN a.detail_type='opening_balance_equity' THEN 0 ELSE 1 END, a.code
   LIMIT 1;

  IF v_acc IS NULL THEN
    v_code := '3900';
    SELECT count(*) INTO v_clash FROM public.accounts
     WHERE organization_id=_org_id AND business_id=_business_id AND code=v_code;
    IF v_clash > 0 THEN v_code := '3900-SYS'; END IF;

    INSERT INTO public.accounts (
      organization_id, business_id, account_type, detail_type,
      code, name, description, is_system, is_active, opening_balance, current_balance
    ) VALUES (
      _org_id, _business_id, 'equity', 'opening_balance_equity',
      v_code, 'Opening Balance Equity',
      'System Opening Balance Equity — contra account for opening balances (auto-provisioned).',
      true, true, 0, 0
    )
    RETURNING id INTO v_acc;
  END IF;

  INSERT INTO public.default_account_settings
    (organization_id, business_id, branch_id, setting_key, account_id)
  VALUES (_org_id, _business_id, NULL, 'opening_balance_equity', v_acc)
  ON CONFLICT (organization_id, business_id, branch_id, setting_key) DO NOTHING;

  RETURN v_acc;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_opening_balance_equity_account(uuid, uuid)
  TO authenticated, service_role;

-- 5. Route opening_balance adjustments to Opening Balance Equity (Odoo/NetSuite/SAP convention).
CREATE OR REPLACE FUNCTION public.resolve_adjustment_offset_account(
  p_org_id uuid,
  p_business_id uuid,
  p_reason text,
  p_sign int
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_shrink uuid;
  v_over   uuid;
  v_reval  uuid;
  v_legacy uuid;
  v_obe    uuid;
BEGIN
  SELECT shrinkage_account_id, overage_account_id, revaluation_account_id
    INTO v_shrink, v_over, v_reval
    FROM public.ensure_inventory_reason_gl_accounts(p_org_id, p_business_id);

  SELECT adjustment_account_id INTO v_legacy
    FROM public.ensure_inventory_gl_accounts(p_org_id, p_business_id);

  IF lower(COALESCE(p_reason, '')) = 'opening_balance' THEN
    v_obe := public.ensure_opening_balance_equity_account(p_org_id, p_business_id);
  END IF;

  RETURN CASE lower(COALESCE(p_reason, ''))
    WHEN 'shrinkage'       THEN v_shrink
    WHEN 'damage'          THEN v_shrink
    WHEN 'write_off'       THEN v_shrink
    WHEN 'found_stock'     THEN v_over
    WHEN 'revaluation'     THEN v_reval
    WHEN 'count_variance'  THEN CASE WHEN p_sign >= 0 THEN v_over ELSE v_shrink END
    WHEN 'opening_balance' THEN v_obe
    ELSE v_legacy
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_adjustment_offset_account(uuid, uuid, text, int)
  TO authenticated, service_role;

-- 6. Wrap notification fan-out so a notification failure cannot roll back the GL transaction.
CREATE OR REPLACE FUNCTION public.trg_check_warehouse_stock_alerts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR COALESCE(NEW.quantity, 0) IS DISTINCT FROM COALESCE(OLD.quantity, 0) THEN
    BEGIN
      PERFORM public.check_warehouse_stock_alerts(NEW.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[trg_check_warehouse_stock_alerts] suppressed % (%): %',
        SQLERRM, SQLSTATE, NEW.id;
    END;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_low_stock_realtime()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.stock_quantity IS DISTINCT FROM NEW.stock_quantity
     AND NEW.stock_quantity < OLD.stock_quantity
     AND NEW.track_inventory = true
     AND NEW.is_active = true THEN
    BEGIN
      PERFORM public.check_product_stock_and_notify(NEW.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[notify_low_stock_realtime] suppressed % (%): product %',
        SQLERRM, SQLSTATE, NEW.id;
    END;
  END IF;
  RETURN NEW;
END;
$$;
