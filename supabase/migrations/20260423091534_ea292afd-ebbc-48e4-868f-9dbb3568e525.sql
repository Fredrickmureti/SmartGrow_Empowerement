-- Stage C: record_opening_stock RPC
-- Records opening balance per warehouse via stock_adjustments + GL posting
-- (DR Inventory / CR Opening Balance Equity)

CREATE OR REPLACE FUNCTION public.record_opening_stock(
  p_business_id uuid,
  p_warehouse_id uuid,
  p_items jsonb,
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  -- Validate inputs
  IF p_business_id IS NULL OR p_warehouse_id IS NULL OR p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'business_id, warehouse_id, and non-empty items are required';
  END IF;

  -- Resolve warehouse scope (org + branch)
  SELECT organization_id, branch_id
    INTO v_org_id, v_branch_id
    FROM warehouses
   WHERE id = p_warehouse_id AND business_id = p_business_id AND is_active = true;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Warehouse % not found in business %', p_warehouse_id, p_business_id;
  END IF;

  -- Resolve GL accounts (must exist for this company)
  SELECT id INTO v_inventory_account_id
    FROM accounts
   WHERE business_id = p_business_id
     AND organization_id = v_org_id
     AND account_type = 'asset'
     AND (LOWER(name) LIKE '%inventory%' OR code LIKE '12%')
     AND is_active = true
   ORDER BY code
   LIMIT 1;

  SELECT id INTO v_opening_equity_account_id
    FROM accounts
   WHERE business_id = p_business_id
     AND organization_id = v_org_id
     AND account_type = 'equity'
     AND (LOWER(name) LIKE '%opening%' OR LOWER(name) LIKE '%retained%' OR code LIKE '3%')
     AND is_active = true
   ORDER BY code
   LIMIT 1;

  IF v_inventory_account_id IS NULL THEN
    RAISE EXCEPTION 'Inventory asset account not found in chart of accounts for this company';
  END IF;
  IF v_opening_equity_account_id IS NULL THEN
    RAISE EXCEPTION 'Opening Balance / Equity account not found in chart of accounts for this company';
  END IF;

  -- Generate adjustment number
  v_adjustment_number := 'OPEN-' || to_char(now(), 'YYYYMMDD-HH24MISS');

  -- Create adjustment header
  INSERT INTO stock_adjustments (
    organization_id, business_id, branch_id, warehouse_id,
    adjustment_number, reason, status, notes, created_by, adjustment_date
  ) VALUES (
    v_org_id, p_business_id, v_branch_id, p_warehouse_id,
    v_adjustment_number, 'opening_balance', 'approved',
    'Opening balance entry', p_user_id, now()
  ) RETURNING id INTO v_adjustment_id;

  -- Loop items: insert adjustment lines + stock_movements (the trigger updates warehouse_stock + products.stock_quantity)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_quantity := COALESCE((v_item->>'quantity')::numeric, 0);
    v_unit_cost := COALESCE((v_item->>'unit_cost')::numeric, 0);

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

  -- Post GL: DR Inventory / CR Opening Equity
  IF v_total_value > 0 THEN
    INSERT INTO journal_entries (
      organization_id, business_id, entry_number, entry_date,
      description, status, source_type, source_id, created_by
    ) VALUES (
      v_org_id, p_business_id,
      'JE-' || v_adjustment_number,
      CURRENT_DATE,
      'Opening stock balance — ' || v_adjustment_number,
      'posted', 'stock_adjustment', v_adjustment_id, p_user_id
    ) RETURNING id INTO v_je_id;

    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, debit, credit, description, business_id, organization_id
    ) VALUES
      (v_je_id, v_inventory_account_id, v_total_value, 0, 'Opening inventory', p_business_id, v_org_id),
      (v_je_id, v_opening_equity_account_id, 0, v_total_value, 'Opening balance equity', p_business_id, v_org_id);
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

GRANT EXECUTE ON FUNCTION public.record_opening_stock(uuid, uuid, jsonb, uuid) TO authenticated;