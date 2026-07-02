
INSERT INTO public.system_account_roles (role_key, label, description, required_account_type, is_mandatory, category, sort_order)
VALUES (
  'grni', 'Goods Received Not Invoiced',
  'Accrual for inventory received but not yet invoiced (GRNI clearing).',
  'liability', false, 'purchasing', 500
)
ON CONFLICT (role_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.ensure_inventory_gl_accounts(_org_id uuid, _business_id uuid)
RETURNS TABLE(inventory_account_id uuid, adjustment_account_id uuid, cogs_account_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_inv uuid; v_adj uuid; v_cogs uuid;
BEGIN
  IF _org_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'ensure_inventory_gl_accounts requires org and business ids';
  END IF;

  SELECT account_id INTO v_inv FROM default_account_settings
   WHERE organization_id=_org_id AND business_id=_business_id AND setting_key='inventory' LIMIT 1;
  IF v_inv IS NULL THEN
    v_inv := public.upsert_system_account(
      _org_id, _business_id, 'inventory', 'asset', 'inventory',
      '1130', 'Inventory', 'System inventory asset account (auto-provisioned)'
    );
  END IF;
  INSERT INTO default_account_settings (organization_id, business_id, branch_id, setting_key, account_id)
  VALUES (_org_id, _business_id, NULL, 'inventory', v_inv)
  ON CONFLICT (organization_id, business_id, branch_id, setting_key)
  DO UPDATE SET account_id = EXCLUDED.account_id
   WHERE default_account_settings.account_id IS NULL;

  SELECT account_id INTO v_adj FROM default_account_settings
   WHERE organization_id=_org_id AND business_id=_business_id AND setting_key='inventory_adjustment' LIMIT 1;
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
    v_adj := public.upsert_system_account(
      _org_id, _business_id, 'inventory_adjustment', 'expense', 'other_business_expenses',
      '5150', 'Inventory Adjustment', 'System inventory adjustment / shrinkage account (auto-provisioned)'
    );
  END IF;
  INSERT INTO default_account_settings (organization_id, business_id, branch_id, setting_key, account_id)
  VALUES (_org_id, _business_id, NULL, 'inventory_adjustment', v_adj)
  ON CONFLICT (organization_id, business_id, branch_id, setting_key)
  DO UPDATE SET account_id = EXCLUDED.account_id
   WHERE default_account_settings.account_id IS NULL;

  SELECT account_id INTO v_cogs FROM default_account_settings
   WHERE organization_id=_org_id AND business_id=_business_id AND setting_key='cogs' LIMIT 1;
  IF v_cogs IS NULL THEN
    v_cogs := public.upsert_system_account(
      _org_id, _business_id, 'cogs', 'expense', 'cost_of_goods_sold',
      '5100', 'Cost of Goods Sold', 'System COGS account (auto-provisioned)'
    );
  END IF;
  INSERT INTO default_account_settings (organization_id, business_id, branch_id, setting_key, account_id)
  VALUES (_org_id, _business_id, NULL, 'cogs', v_cogs)
  ON CONFLICT (organization_id, business_id, branch_id, setting_key)
  DO UPDATE SET account_id = EXCLUDED.account_id
   WHERE default_account_settings.account_id IS NULL;

  inventory_account_id := v_inv;
  adjustment_account_id := v_adj;
  cogs_account_id := v_cogs;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ensure_inventory_reason_gl_accounts(_org_id uuid, _business_id uuid)
RETURNS TABLE(shrinkage_account_id uuid, overage_account_id uuid, revaluation_account_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_shrink uuid; v_over uuid; v_reval uuid; v_legacy_adj uuid;
BEGIN
  IF _org_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'ensure_inventory_reason_gl_accounts requires org and business ids';
  END IF;

  SELECT adjustment_account_id INTO v_legacy_adj
    FROM public.ensure_inventory_gl_accounts(_org_id, _business_id);

  SELECT account_id INTO v_shrink FROM public.default_account_settings
   WHERE organization_id=_org_id AND business_id=_business_id
     AND setting_key='inventory_shrinkage_expense' LIMIT 1;
  IF v_shrink IS NULL THEN
    v_shrink := v_legacy_adj;
    INSERT INTO public.default_account_settings (organization_id, business_id, branch_id, setting_key, account_id)
    VALUES (_org_id, _business_id, NULL, 'inventory_shrinkage_expense', v_shrink)
    ON CONFLICT (organization_id, business_id, branch_id, setting_key) DO NOTHING;
  END IF;

  SELECT account_id INTO v_over FROM public.default_account_settings
   WHERE organization_id=_org_id AND business_id=_business_id
     AND setting_key='inventory_overage_income' LIMIT 1;
  IF v_over IS NULL THEN
    SELECT id INTO v_over FROM public.accounts
     WHERE organization_id=_org_id AND business_id=_business_id
       AND detail_type IN ('other_income','other_business_income')
       AND coalesce(is_header,false)=false AND is_active=true
       AND (name ILIKE '%inventory%over%' OR name ILIKE '%found%stock%' OR name ILIKE '%inventory%gain%')
     ORDER BY code LIMIT 1;
    IF v_over IS NULL THEN
      v_over := public.upsert_system_account(
        _org_id, _business_id, 'inventory_overage_income', 'income', 'other_business_income',
        '4910', 'Inventory Overage / Found Stock',
        'System inventory overage / found-stock income (auto-provisioned)'
      );
    END IF;
    INSERT INTO public.default_account_settings (organization_id, business_id, branch_id, setting_key, account_id)
    VALUES (_org_id, _business_id, NULL, 'inventory_overage_income', v_over)
    ON CONFLICT (organization_id, business_id, branch_id, setting_key) DO NOTHING;
  END IF;

  SELECT account_id INTO v_reval FROM public.default_account_settings
   WHERE organization_id=_org_id AND business_id=_business_id
     AND setting_key='inventory_revaluation' LIMIT 1;
  IF v_reval IS NULL THEN
    v_reval := v_legacy_adj;
    INSERT INTO public.default_account_settings (organization_id, business_id, branch_id, setting_key, account_id)
    VALUES (_org_id, _business_id, NULL, 'inventory_revaluation', v_reval)
    ON CONFLICT (organization_id, business_id, branch_id, setting_key) DO NOTHING;
  END IF;

  shrinkage_account_id := v_shrink;
  overage_account_id := v_over;
  revaluation_account_id := v_reval;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ensure_opening_balance_equity_account(_org_id uuid, _business_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_acc uuid;
BEGIN
  IF _org_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'ensure_opening_balance_equity_account requires org and business ids';
  END IF;

  SELECT account_id INTO v_acc FROM public.default_account_settings
   WHERE organization_id=_org_id AND business_id=_business_id
     AND setting_key='opening_balance_equity' LIMIT 1;
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
    v_acc := public.upsert_system_account(
      _org_id, _business_id, 'opening_balance_equity', 'equity', 'opening_balance_equity',
      '3900', 'Opening Balance Equity',
      'System Opening Balance Equity — contra account for opening balances (auto-provisioned).'
    );
  END IF;

  INSERT INTO public.default_account_settings
    (organization_id, business_id, branch_id, setting_key, account_id)
  VALUES (_org_id, _business_id, NULL, 'opening_balance_equity', v_acc)
  ON CONFLICT (organization_id, business_id, branch_id, setting_key) DO NOTHING;

  RETURN v_acc;
END;
$function$;

CREATE OR REPLACE FUNCTION public.provision_system_account(_role_key text, _organization_id uuid, _business_id uuid)
RETURNS accounts
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_role_role text;
  v_template public.system_account_template%ROWTYPE;
  v_parent_id uuid;
  v_account_id uuid;
  v_row public.accounts%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  IF _organization_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'organization_id and business_id are required' USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_role_role
  FROM public.user_roles
  WHERE user_id = v_caller
    AND organization_id = _organization_id
    AND coalesce(is_active, true) = true
  LIMIT 1;
  IF v_role_role IS NULL OR v_role_role NOT IN ('super_admin','owner','admin','accountant') THEN
    RAISE EXCEPTION 'forbidden: % cannot provision system accounts', coalesce(v_role_role,'<none>')
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_template FROM public.system_account_template WHERE role_key = _role_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no template registered for role "%"', _role_key USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_parent_id
  FROM public.accounts
  WHERE organization_id = _organization_id
    AND coalesce(is_header, false) = true
    AND account_type = v_template.account_type
    AND code = v_template.parent_code_hint
    AND (business_id = _business_id OR business_id IS NULL)
  ORDER BY (business_id IS NULL)
  LIMIT 1;
  IF v_parent_id IS NULL THEN
    SELECT id INTO v_parent_id
    FROM public.accounts
    WHERE organization_id = _organization_id
      AND coalesce(is_header, false) = true
      AND account_type = v_template.account_type
      AND (business_id = _business_id OR business_id IS NULL)
    ORDER BY (business_id IS NULL), code
    LIMIT 1;
  END IF;

  v_account_id := public.upsert_system_account(
    _organization_id, _business_id, _role_key,
    v_template.account_type::text, v_template.detail_type::text,
    v_template.suggested_code, v_template.suggested_name,
    v_template.description, v_parent_id, false
  );

  SELECT * INTO v_row FROM public.accounts WHERE id = v_account_id;
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_goods_receipt_atomic(p_grn_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_grn RECORD; v_po RECORD; v_item RECORD;
  v_warehouse_id uuid; v_branch_id uuid; v_org_id uuid; v_biz_id uuid;
  v_inventory_acct uuid; v_grni_acct uuid; v_journal_id uuid;
  v_total_cost numeric := 0; v_line_cost numeric; v_unit_cost numeric;
  v_movement_count int := 0; v_all_received boolean; v_any_received boolean := false;
BEGIN
  SELECT id, organization_id, business_id, warehouse_id, branch_id,
         purchase_order_id, receipt_number, status
    INTO v_grn FROM goods_receipts WHERE id = p_grn_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Goods receipt not found'); END IF;
  IF v_grn.status = 'completed' THEN RETURN jsonb_build_object('success', false, 'error', 'Goods receipt already completed'); END IF;

  v_org_id := v_grn.organization_id; v_biz_id := v_grn.business_id; v_warehouse_id := v_grn.warehouse_id;
  IF v_warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Goods receipt has no warehouse — set warehouse_id before completing');
  END IF;

  SELECT business_id, branch_id INTO v_biz_id, v_branch_id FROM warehouses WHERE id = v_warehouse_id;
  IF v_biz_id IS NULL OR v_biz_id <> v_grn.business_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Warehouse does not belong to receipt company');
  END IF;

  SELECT id, po_number, status INTO v_po FROM purchase_orders WHERE id = v_grn.purchase_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Purchase order not found'); END IF;

  FOR v_item IN
    SELECT gri.id, gri.product_id, gri.purchase_order_item_id,
           gri.description, gri.quantity_received,
           gri.lot_number, gri.serial_number, gri.notes,
           poi.unit_price, poi.quantity AS po_quantity,
           poi.quantity_received AS po_qty_already_received,
           p.cost_price, p.track_inventory, p.inventory_account_id
      FROM goods_receipt_items gri
 LEFT JOIN purchase_order_items poi ON poi.id = gri.purchase_order_item_id
 LEFT JOIN products p ON p.id = gri.product_id
     WHERE gri.goods_receipt_id = p_grn_id
  LOOP
    v_any_received := true;
    IF v_item.product_id IS NOT NULL AND COALESCE(v_item.track_inventory, true) THEN
      v_unit_cost := COALESCE(v_item.unit_price, v_item.cost_price, 0);
      INSERT INTO stock_movements (
        organization_id, business_id, branch_id, warehouse_id,
        product_id, movement_type, quantity, unit_cost,
        reference_type, reference_id, notes,
        lot_number, serial_number, created_by
      ) VALUES (
        v_org_id, v_biz_id, v_branch_id, v_warehouse_id,
        v_item.product_id, 'receipt', v_item.quantity_received, v_unit_cost,
        'goods_receipt', p_grn_id,
        'GRN ' || v_grn.receipt_number || COALESCE(' — ' || v_item.description, ''),
        v_item.lot_number, v_item.serial_number, p_user_id
      );
      v_movement_count := v_movement_count + 1;
      v_line_cost := v_item.quantity_received * v_unit_cost;
      v_total_cost := v_total_cost + v_line_cost;
    END IF;
    IF v_item.purchase_order_item_id IS NOT NULL THEN
      UPDATE purchase_order_items
         SET quantity_received = COALESCE(quantity_received, 0) + v_item.quantity_received,
             receipt_status = CASE
               WHEN COALESCE(quantity_received, 0) + v_item.quantity_received >= quantity THEN 'received'
               ELSE 'partial'
             END
       WHERE id = v_item.purchase_order_item_id;
    END IF;
  END LOOP;

  UPDATE goods_receipts SET status = 'completed', updated_at = now() WHERE id = p_grn_id;

  SELECT bool_and(COALESCE(quantity_received, 0) >= quantity) INTO v_all_received
    FROM purchase_order_items WHERE purchase_order_id = v_po.id;
  IF v_all_received THEN
    UPDATE purchase_orders SET status = 'received' WHERE id = v_po.id;
  ELSIF v_any_received THEN
    UPDATE purchase_orders SET status = 'partial_received' WHERE id = v_po.id;
  END IF;

  IF v_total_cost > 0 THEN
    SELECT id INTO v_inventory_acct FROM accounts
     WHERE organization_id = v_org_id AND business_id = v_biz_id
       AND detail_type = 'inventory' AND is_active = true LIMIT 1;

    SELECT id INTO v_grni_acct FROM accounts
     WHERE business_id = v_biz_id AND system_role = 'grni' LIMIT 1;
    IF v_grni_acct IS NULL THEN
      SELECT id INTO v_grni_acct FROM accounts
       WHERE organization_id = v_org_id AND business_id = v_biz_id
         AND (detail_type = 'grni' OR code = '21100')
         AND is_active = true LIMIT 1;
    END IF;
    IF v_grni_acct IS NULL THEN
      v_grni_acct := public.upsert_system_account(
        v_org_id, v_biz_id, 'grni', 'liability', 'other_current_liabilities',
        '21100', 'Goods Received Not Invoiced',
        'Accrual for inventory received but not yet invoiced (GRNI clearing)'
      );
    END IF;

    IF v_inventory_acct IS NOT NULL AND v_grni_acct IS NOT NULL THEN
      INSERT INTO journal_entries (
        organization_id, business_id, entry_date, reference, memo,
        source_type, source_id, status, created_by
      ) VALUES (
        v_org_id, v_biz_id, CURRENT_DATE, v_grn.receipt_number,
        'Inventory received — ' || v_grn.receipt_number,
        'goods_receipt', p_grn_id::text, 'posted', p_user_id
      ) RETURNING id INTO v_journal_id;

      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_amount, credit_amount, description)
      VALUES
        (v_journal_id, v_inventory_acct, v_total_cost, 0, 'Inventory in — ' || v_grn.receipt_number),
        (v_journal_id, v_grni_acct, 0, v_total_cost, 'GRNI accrual — ' || v_grn.receipt_number);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'grn_id', p_grn_id,
    'movements_created', v_movement_count,
    'total_cost', v_total_cost,
    'gl_posted', v_journal_id IS NOT NULL,
    'po_status', CASE WHEN v_all_received THEN 'received' ELSE 'partial_received' END
  );
END;
$function$;
