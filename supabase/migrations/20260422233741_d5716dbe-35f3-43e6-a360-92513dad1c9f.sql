
-- ============================================================================
-- A2/C3: Allow in-transit warehouses to carry any branch within their business
-- ============================================================================
CREATE OR REPLACE FUNCTION public.enforce_stock_movement_branch_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_warehouse RECORD;
BEGIN
  IF NEW.warehouse_id IS NOT NULL THEN
    SELECT id, organization_id, business_id, branch_id, is_in_transit
    INTO v_warehouse
    FROM public.warehouses
    WHERE id = NEW.warehouse_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'stock_movements.warehouse_id % does not exist', NEW.warehouse_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF v_warehouse.organization_id IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'stock_movements.warehouse_id % belongs to organization_id %, not %',
        NEW.warehouse_id, v_warehouse.organization_id, NEW.organization_id
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_warehouse.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'stock_movements.warehouse_id % belongs to business_id %, not %',
        NEW.warehouse_id, v_warehouse.business_id, NEW.business_id
        USING ERRCODE = 'check_violation';
    END IF;

    -- In-transit warehouses are virtual transit locations: they are pinned to
    -- the HQ branch in the warehouses table only because the FK requires a
    -- branch, but they participate in moves whose branch is the dispatch or
    -- receive branch (per the two-step in-transit transfer model).
    IF NEW.branch_id IS NULL THEN
      NEW.branch_id := v_warehouse.branch_id;
    ELSIF v_warehouse.is_in_transit = true THEN
      -- Permit any branch within the same business for in-transit warehouses.
      -- The branch validity check below still verifies the branch belongs to
      -- this org+business.
      NULL;
    ELSIF v_warehouse.branch_id IS NOT NULL AND NEW.branch_id IS DISTINCT FROM v_warehouse.branch_id THEN
      RAISE EXCEPTION 'stock_movements.branch_id % does not match warehouse branch_id %',
        NEW.branch_id, v_warehouse.branch_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.branch_id IS NOT NULL THEN
    PERFORM 1
    FROM public.branches b
    WHERE b.id = NEW.branch_id
      AND b.organization_id = NEW.organization_id
      AND b.business_id = NEW.business_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'stock_movements.branch_id % does not belong to organization_id % and business_id %',
        NEW.branch_id, NEW.organization_id, NEW.business_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;


-- ============================================================================
-- C1/C2/L2: Rewrite process_pos_return to use stock_movements + register scope
-- ============================================================================
CREATE OR REPLACE FUNCTION public.process_pos_return(
  p_organization_id uuid,
  p_register_id uuid,
  p_shift_id uuid,
  p_original_transaction_id uuid,
  p_items jsonb,
  p_refund_method text DEFAULT 'cash'::text,
  p_notes text DEFAULT NULL::text,
  p_created_by uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_transaction_id UUID;
  v_transaction_number TEXT;
  v_register_code TEXT;
  v_register_branch_id UUID;
  v_register_business_id UUID;
  v_register_org_id UUID;
  v_shift_warehouse_id UUID;
  v_default_warehouse_id UUID;
  v_item JSONB;
  v_product_id UUID;
  v_quantity NUMERIC;
  v_track_inventory BOOLEAN;
  v_subtotal NUMERIC := 0;
  v_tax_amount NUMERIC := 0;
  v_total NUMERIC := 0;
  v_item_index INT := 0;
  v_original_status TEXT;
  v_original_business_id UUID;
  v_already_returned NUMERIC;
  v_original_qty NUMERIC;
  v_item_total NUMERIC;
  v_item_tax NUMERIC;
BEGIN
  -- Register is the single source of truth for (org, business, branch).
  SELECT register_code, branch_id, business_id, organization_id
    INTO v_register_code, v_register_branch_id, v_register_business_id, v_register_org_id
  FROM public.pos_registers
  WHERE id = p_register_id;

  IF v_register_code IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_register', 'details', 'Register not found');
  END IF;

  -- Cross-company contamination guard (mirror process_pos_transaction).
  IF v_register_org_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'Register % belongs to a different organization than supplied (% vs %)',
      p_register_id, v_register_org_id, p_organization_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_register_branch_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_register', 'details', 'Register has no branch context');
  END IF;

  -- Validate original transaction exists, is completed, and belongs to the
  -- same company as the register processing the return.
  SELECT status, business_id INTO v_original_status, v_original_business_id
  FROM public.pos_transactions
  WHERE id = p_original_transaction_id
    AND organization_id = p_organization_id;

  IF v_original_status IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'original_not_found', 'details', 'Original transaction not found');
  END IF;

  IF v_original_status != 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status',
      'details', 'Original transaction is not completed (status: ' || v_original_status || ')');
  END IF;

  IF v_original_business_id IS DISTINCT FROM v_register_business_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'cross_company_return',
      'details', 'Original transaction belongs to a different company than this register');
  END IF;

  -- Resolve the warehouse the same way process_pos_transaction does:
  -- shift-locked → branch-default. NO business-wide fallback (A3).
  SELECT warehouse_id INTO v_shift_warehouse_id
  FROM public.pos_shifts
  WHERE id = p_shift_id
    AND organization_id = v_register_org_id
    AND business_id     = v_register_business_id
    AND register_id     = p_register_id;

  v_default_warehouse_id := v_shift_warehouse_id;

  IF v_default_warehouse_id IS NULL THEN
    SELECT id INTO v_default_warehouse_id
    FROM public.warehouses
    WHERE organization_id = v_register_org_id
      AND business_id     = v_register_business_id
      AND branch_id       = v_register_branch_id
      AND is_active       = true
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1;
  END IF;

  -- Validate each return item against original and check double-return.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;

    SELECT quantity INTO v_original_qty
    FROM public.pos_transaction_items
    WHERE id = (v_item->>'original_item_id')::UUID
      AND transaction_id = p_original_transaction_id;

    IF v_original_qty IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'item_not_found',
        'details', 'Original item not found: ' || COALESCE(v_item->>'description', 'unknown'));
    END IF;

    SELECT COALESCE(SUM(ti.quantity), 0) INTO v_already_returned
    FROM public.pos_transaction_items ti
    JOIN public.pos_transactions t ON t.id = ti.transaction_id
    WHERE t.original_transaction_id = p_original_transaction_id
      AND t.transaction_type = 'return'
      AND t.status = 'completed'
      AND ti.product_id = v_product_id;

    IF v_quantity > (v_original_qty - v_already_returned) THEN
      RETURN jsonb_build_object('success', false, 'error', 'excess_return',
        'details', format('Cannot return %s of "%s" — only %s remaining (%s already returned)',
          v_quantity, v_item->>'description', v_original_qty - v_already_returned, v_already_returned));
    END IF;
  END LOOP;

  v_transaction_number := public.get_next_pos_transaction_number(p_organization_id, v_register_code);

  -- Calculate totals.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_quantity := (v_item->>'quantity')::NUMERIC;
    v_item_total := (v_item->>'unit_price')::NUMERIC * v_quantity;
    v_item_tax := v_item_total * COALESCE((v_item->>'tax_rate')::NUMERIC, 0) / 100;
    v_subtotal := v_subtotal + v_item_total;
    v_tax_amount := v_tax_amount + v_item_tax;
  END LOOP;
  v_total := v_subtotal + v_tax_amount;

  -- Create return transaction stamped with register's (business, branch).
  INSERT INTO public.pos_transactions (
    id, organization_id, business_id, branch_id, register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id,
    subtotal, tax_amount, discount_amount, total,
    payment_status, status, completed_at, created_by, notes, created_at
  ) VALUES (
    gen_random_uuid(), p_organization_id, v_register_business_id, v_register_branch_id,
    p_register_id, p_shift_id, v_transaction_number,
    'return', p_original_transaction_id,
    v_subtotal, v_tax_amount, 0, v_total,
    'refunded', 'completed', now(), p_created_by,
    COALESCE(p_notes, '') || ' Return for txn ' || p_original_transaction_id::TEXT, now()
  ) RETURNING id INTO v_transaction_id;

  -- Insert return items and post stock movements (stock_movements, NOT the
  -- non-existent inventory_movements). The update_product_stock trigger
  -- maintains warehouse_stock and products.stock_quantity.
  v_item_index := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;
    v_item_total := (v_item->>'unit_price')::NUMERIC * v_quantity;
    v_item_tax := v_item_total * COALESCE((v_item->>'tax_rate')::NUMERIC, 0) / 100;

    INSERT INTO public.pos_transaction_items (
      transaction_id, product_id, description, quantity,
      unit_price, discount_type, discount_value,
      tax_rate, tax_amount, line_total, cost_price, sort_order
    ) VALUES (
      v_transaction_id, v_product_id, v_item->>'description', v_quantity,
      (v_item->>'unit_price')::NUMERIC, NULL, 0,
      COALESCE((v_item->>'tax_rate')::NUMERIC, 0), v_item_tax, v_item_total + v_item_tax,
      (v_item->>'cost_price')::NUMERIC, v_item_index
    );

    IF v_product_id IS NOT NULL THEN
      SELECT track_inventory INTO v_track_inventory
      FROM public.products
      WHERE id = v_product_id
        AND organization_id = p_organization_id
        AND business_id     = v_register_business_id;

      IF v_track_inventory = true THEN
        IF v_default_warehouse_id IS NULL THEN
          RAISE EXCEPTION 'No active warehouse found for POS register branch %; create one before processing returns', v_register_branch_id
            USING ERRCODE = 'check_violation';
        END IF;

        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, unit_cost,
          reference_type, reference_id, notes, created_by, movement_date
        ) VALUES (
          p_organization_id, v_register_business_id, v_register_branch_id,
          v_product_id, v_default_warehouse_id,
          'pos_return', v_quantity,
          COALESCE((v_item->>'cost_price')::NUMERIC, 0),
          'pos_transaction', v_transaction_id,
          'POS Return: ' || v_transaction_number,
          p_created_by,
          now()
        );
      END IF;
    END IF;

    v_item_index := v_item_index + 1;
  END LOOP;

  -- Refund payment record.
  INSERT INTO public.pos_transaction_payments (
    transaction_id, payment_method, amount, reference, status
  ) VALUES (
    v_transaction_id,
    CASE WHEN p_refund_method = 'store_credit' THEN 'voucher' ELSE p_refund_method END,
    -v_total,
    'Refund - ' || v_transaction_number,
    'completed'
  );

  IF p_refund_method = 'cash' THEN
    UPDATE public.pos_shifts
    SET expected_cash = COALESCE(expected_cash, 0) - v_total,
        total_returns = COALESCE(total_returns, 0) + v_total,
        updated_at    = now()
    WHERE id = p_shift_id;
  ELSE
    UPDATE public.pos_shifts
    SET total_returns = COALESCE(total_returns, 0) + v_total,
        updated_at    = now()
    WHERE id = p_shift_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'transaction_number', v_transaction_number,
    'refund_amount', v_total,
    'business_id', v_register_business_id,
    'branch_id', v_register_branch_id
  );
END;
$function$;


-- ============================================================================
-- D2: Company-scoped inventory reset (optional business_id)
-- ============================================================================
-- Drop the legacy single-arg signature so the typed RPC layer regenerates.
-- The new function defaults business_id to NULL (org-wide) for backwards
-- compatibility with the wipe-all flow, but the UI should pass a business_id
-- to scope the wipe to a single company.
DROP FUNCTION IF EXISTS public.reset_module__inventory(uuid);

CREATE OR REPLACE FUNCTION public.reset_module__inventory(
  org_id uuid,
  business_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb := '{}'::jsonb;
  n bigint;
  v_biz uuid := business_id;
BEGIN
  -- stock_movements
  IF v_biz IS NULL THEN
    WITH d AS (DELETE FROM public.stock_movements WHERE organization_id=org_id RETURNING 1)
      SELECT count(*) INTO n FROM d;
  ELSE
    WITH d AS (DELETE FROM public.stock_movements
                WHERE organization_id=org_id AND business_id=v_biz RETURNING 1)
      SELECT count(*) INTO n FROM d;
  END IF;
  v := v || jsonb_build_object('stock_movements', n);

  -- stock_adjustment_items (scoped through parent stock_adjustments)
  IF v_biz IS NULL THEN
    WITH d AS (DELETE FROM public.stock_adjustment_items
                WHERE adjustment_id IN (SELECT id FROM public.stock_adjustments WHERE organization_id=org_id)
                RETURNING 1) SELECT count(*) INTO n FROM d;
  ELSE
    WITH d AS (DELETE FROM public.stock_adjustment_items
                WHERE adjustment_id IN (
                  SELECT id FROM public.stock_adjustments
                  WHERE organization_id=org_id AND business_id=v_biz
                )
                RETURNING 1) SELECT count(*) INTO n FROM d;
  END IF;
  v := v || jsonb_build_object('stock_adjustment_items', n);

  -- stock_adjustments
  IF v_biz IS NULL THEN
    WITH d AS (DELETE FROM public.stock_adjustments WHERE organization_id=org_id RETURNING 1)
      SELECT count(*) INTO n FROM d;
  ELSE
    WITH d AS (DELETE FROM public.stock_adjustments
                WHERE organization_id=org_id AND business_id=v_biz RETURNING 1)
      SELECT count(*) INTO n FROM d;
  END IF;
  v := v || jsonb_build_object('stock_adjustments', n);

  -- goods_receipt_items (scoped through parent goods_receipts)
  IF v_biz IS NULL THEN
    WITH d AS (DELETE FROM public.goods_receipt_items
                WHERE goods_receipt_id IN (SELECT id FROM public.goods_receipts WHERE organization_id=org_id)
                RETURNING 1) SELECT count(*) INTO n FROM d;
  ELSE
    WITH d AS (DELETE FROM public.goods_receipt_items
                WHERE goods_receipt_id IN (
                  SELECT id FROM public.goods_receipts
                  WHERE organization_id=org_id AND business_id=v_biz
                )
                RETURNING 1) SELECT count(*) INTO n FROM d;
  END IF;
  v := v || jsonb_build_object('goods_receipt_items', n);

  -- goods_receipts
  IF v_biz IS NULL THEN
    WITH d AS (DELETE FROM public.goods_receipts WHERE organization_id=org_id RETURNING 1)
      SELECT count(*) INTO n FROM d;
  ELSE
    WITH d AS (DELETE FROM public.goods_receipts
                WHERE organization_id=org_id AND business_id=v_biz RETURNING 1)
      SELECT count(*) INTO n FROM d;
  END IF;
  v := v || jsonb_build_object('goods_receipts', n);

  -- backorders
  IF v_biz IS NULL THEN
    WITH d AS (DELETE FROM public.backorders WHERE organization_id=org_id RETURNING 1)
      SELECT count(*) INTO n FROM d;
  ELSE
    WITH d AS (DELETE FROM public.backorders
                WHERE organization_id=org_id AND business_id=v_biz RETURNING 1)
      SELECT count(*) INTO n FROM d;
  END IF;
  v := v || jsonb_build_object('backorders', n);

  -- replenishment_logs (org-only, no business_id column on this table)
  WITH d AS (DELETE FROM public.replenishment_logs WHERE organization_id=org_id RETURNING 1)
    SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('replenishment_logs', n);

  RETURN v;
END;
$function$;
