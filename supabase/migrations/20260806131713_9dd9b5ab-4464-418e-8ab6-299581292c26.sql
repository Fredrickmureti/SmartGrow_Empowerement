CREATE OR REPLACE FUNCTION public.finance_post_gr_journal(_gr_id uuid, _actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_grn RECORD; v_total_cost numeric := 0;
  v_inventory_acct uuid; v_grni_acct uuid; v_journal_id uuid;
BEGIN
  SELECT id, organization_id, business_id, branch_id, warehouse_id, receipt_number
    INTO v_grn FROM goods_receipts WHERE id = _gr_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Goods receipt not found'); END IF;

  SELECT COALESCE(SUM(quantity * unit_cost), 0)
    INTO v_total_cost
    FROM stock_movements
   WHERE reference_type = 'goods_receipt' AND reference_id = _gr_id;

  IF v_total_cost <= 0 THEN
    RETURN jsonb_build_object('success', true, 'total_cost', 0, 'journal_id', NULL);
  END IF;

  SELECT id INTO v_inventory_acct FROM accounts
   WHERE organization_id = v_grn.organization_id AND business_id = v_grn.business_id
     AND detail_type = 'inventory' AND is_active = true LIMIT 1;
  SELECT id INTO v_grni_acct FROM accounts
   WHERE business_id = v_grn.business_id AND system_role = 'grni' LIMIT 1;

  IF v_inventory_acct IS NULL OR v_grni_acct IS NULL THEN
    RETURN jsonb_build_object('success', true, 'total_cost', v_total_cost, 'journal_id', NULL,
      'warning', 'Inventory or GR/NI account missing — journal skipped');
  END IF;

  -- Single posting monopoly: delegate to post_journal_entry_atomic.
  v_journal_id := public.post_journal_entry_atomic(
    v_grn.organization_id, v_grn.business_id,
    public.generate_next_je_number(v_grn.organization_id, v_grn.business_id),
    current_date,
    v_grn.receipt_number,
    'GRN ' || v_grn.receipt_number || ' — Inventory receipt',
    'goods_receipt', _gr_id, _actor, false, false,
    jsonb_build_array(
      jsonb_build_object('account_id', v_inventory_acct, 'debit', v_total_cost, 'credit', 0,
        'description', 'Inventory in (GRN ' || v_grn.receipt_number || ')'),
      jsonb_build_object('account_id', v_grni_acct, 'debit', 0, 'credit', v_total_cost,
        'description', 'GR/NI accrual (GRN ' || v_grn.receipt_number || ')')
    ),
    NULL, NULL, NULL, v_grn.branch_id
  );

  -- Preserve legacy reference_type/reference_id lookups.
  UPDATE journal_entries
     SET reference_type = 'goods_receipt', reference_id = _gr_id
   WHERE id = v_journal_id;

  RETURN jsonb_build_object('success', true, 'total_cost', v_total_cost, 'journal_id', v_journal_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.backfill_opening_inventory_gl(p_org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  SELECT id INTO v_business FROM public.businesses WHERE organization_id = p_org LIMIT 1;

  v_je_id := public.post_journal_entry_atomic(
    p_org, v_business,
    public.generate_next_je_number(p_org, v_business),
    COALESCE(v_first_date, current_date),
    NULL,
    'Opening Inventory — backfill from zero-cost stock adjustments',
    'stock_adjustment_backfill', NULL, auth.uid(), false, false,
    jsonb_build_array(
      jsonb_build_object('account_id', v_inv_account, 'debit', v_total, 'credit', 0,
        'description', 'Opening inventory at cost'),
      jsonb_build_object('account_id', v_obe_account, 'debit', 0, 'credit', v_total,
        'description', 'Opening Balance Equity')
    ),
    NULL, NULL, NULL, NULL
  );

  UPDATE public.journal_entries SET is_opening_entry = true WHERE id = v_je_id;

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
$function$;

CREATE OR REPLACE FUNCTION public.record_opening_stock(p_business_id uuid, p_warehouse_id uuid, p_items jsonb, p_user_id uuid DEFAULT auth.uid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id uuid;
  v_branch_id uuid;
  v_adjustment_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_quantity numeric;
  v_unit_cost numeric;
  v_total_value numeric := 0;
  v_inventory_account_id uuid;
  v_opening_equity_account_id uuid;
  v_je_id uuid;
  v_adjustment_number text;
  v_count integer := 0;
BEGIN
  IF p_business_id IS NULL OR p_warehouse_id IS NULL OR p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'business_id, warehouse_id, and non-empty items are required';
  END IF;

  SELECT organization_id, branch_id
    INTO v_org_id, v_branch_id
    FROM warehouses
   WHERE id = p_warehouse_id AND business_id = p_business_id AND is_active = true;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Warehouse % not found in business %', p_warehouse_id, p_business_id;
  END IF;

  v_inventory_account_id      := public.resolve_default_account(p_business_id, 'inventory');
  v_opening_equity_account_id := public.resolve_default_account(p_business_id, 'opening_equity');

  IF v_inventory_account_id IS NULL THEN
    RAISE EXCEPTION 'Inventory asset account not found in chart of accounts for this company';
  END IF;
  IF v_opening_equity_account_id IS NULL THEN
    RAISE EXCEPTION 'Opening Balance / Equity account not found in chart of accounts for this company';
  END IF;

  v_adjustment_number := 'OPEN-' || to_char(now(), 'YYYYMMDD-HH24MISS');

  INSERT INTO stock_adjustments (
    organization_id, business_id, branch_id, warehouse_id,
    adjustment_number, reason, status, notes, created_by, adjustment_date,
    allow_negative
  ) VALUES (
    v_org_id, p_business_id, v_branch_id, p_warehouse_id,
    v_adjustment_number, 'opening_balance', 'approved',
    'Opening balance entry', p_user_id, now(),
    true
  ) RETURNING id INTO v_adjustment_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_quantity   := COALESCE((v_item->>'quantity')::numeric, 0);
    v_unit_cost  := COALESCE((v_item->>'unit_cost')::numeric, 0);

    IF v_quantity <= 0 THEN CONTINUE; END IF;

    INSERT INTO stock_adjustment_items (
      adjustment_id, product_id, system_quantity, counted_quantity,
      adjustment_quantity, unit_cost
    ) VALUES (
      v_adjustment_id, v_product_id, 0, v_quantity, v_quantity, v_unit_cost
    );

    INSERT INTO stock_movements (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, movement_type, quantity, unit_cost, total_cost,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_org_id, p_business_id, v_branch_id, p_warehouse_id,
      v_product_id, 'opening', v_quantity, v_unit_cost, v_quantity * v_unit_cost,
      'stock_adjustment', v_adjustment_id, 'Opening balance', p_user_id
    );

    v_total_value := v_total_value + (v_quantity * v_unit_cost);
    v_count := v_count + 1;
  END LOOP;

  IF v_total_value > 0 THEN
    v_je_id := public.post_journal_entry_atomic(
      v_org_id, p_business_id,
      'JE-' || v_adjustment_number,
      CURRENT_DATE,
      v_adjustment_number,
      'Opening stock balance — ' || v_adjustment_number,
      'stock_adjustment', v_adjustment_id, p_user_id, false, false,
      jsonb_build_array(
        jsonb_build_object('account_id', v_inventory_account_id, 'debit', v_total_value, 'credit', 0,
          'description', 'Opening inventory'),
        jsonb_build_object('account_id', v_opening_equity_account_id, 'debit', 0, 'credit', v_total_value,
          'description', 'Opening balance equity')
      ),
      NULL, NULL, NULL, v_branch_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'adjustment_id', v_adjustment_id,
    'adjustment_number', v_adjustment_number,
    'item_count', v_count,
    'total_value', v_total_value,
    'journal_entry_id', v_je_id
  );
END;
$function$;