-- =========================================================================
-- STEP 1: Fix process_pos_void (broken — wrote to nonexistent table)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.process_pos_void(
  p_organization_id uuid,
  p_transaction_id uuid,
  p_void_reason text,
  p_voided_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_transaction RECORD;
  v_item RECORD;
  v_warehouse_id uuid;
  v_cash_refund NUMERIC := 0;
BEGIN
  -- Lock and validate the transaction (scoped to org)
  SELECT * INTO v_transaction
  FROM pos_transactions
  WHERE id = p_transaction_id
    AND organization_id = p_organization_id
  FOR UPDATE;

  IF v_transaction IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found', 'details', 'Transaction not found');
  END IF;

  IF v_transaction.status = 'voided' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_voided', 'details', 'Transaction is already voided');
  END IF;

  IF v_transaction.status != 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status', 'details', 'Only completed transactions can be voided');
  END IF;

  -- Resolve the warehouse used at sale time: shift-locked first, then the
  -- branch-default. NO business-wide fallback (mirrors process_pos_return).
  SELECT s.warehouse_id INTO v_warehouse_id
  FROM pos_shifts s
  WHERE s.id = v_transaction.shift_id
    AND s.organization_id = v_transaction.organization_id
    AND s.business_id     = v_transaction.business_id
    AND s.register_id     = v_transaction.register_id;

  IF v_warehouse_id IS NULL THEN
    SELECT id INTO v_warehouse_id
    FROM warehouses
    WHERE organization_id = v_transaction.organization_id
      AND business_id     = v_transaction.business_id
      AND branch_id       = v_transaction.branch_id
      AND is_active       = true
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1;
  END IF;

  -- Insert reversing rows into stock_movements. The update_product_stock
  -- trigger maintains warehouse_stock + the products aggregate.
  FOR v_item IN
    SELECT ti.product_id, ti.quantity, ti.cost_price, p.track_inventory
    FROM pos_transaction_items ti
    LEFT JOIN products p ON p.id = ti.product_id
    WHERE ti.transaction_id = p_transaction_id
  LOOP
    IF v_item.product_id IS NOT NULL AND v_item.track_inventory = true THEN
      IF v_warehouse_id IS NULL THEN
        RAISE EXCEPTION 'No active warehouse found for branch % — cannot reverse stock for void', v_transaction.branch_id
          USING ERRCODE = 'check_violation';
      END IF;

      INSERT INTO stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, unit_cost,
        reference_type, reference_id, notes, created_by, movement_date
      ) VALUES (
        v_transaction.organization_id, v_transaction.business_id, v_transaction.branch_id,
        v_item.product_id, v_warehouse_id,
        'pos_return',  -- reversing entry; existing enum value
        v_item.quantity,                       -- positive: stock back in
        COALESCE(v_item.cost_price, 0),
        'pos_transaction', p_transaction_id,
        'Voided: ' || v_transaction.transaction_number || ' — ' || p_void_reason,
        p_voided_by,
        now()
      );
    END IF;
  END LOOP;

  -- Cash reversal from shift
  SELECT COALESCE(SUM(amount), 0) INTO v_cash_refund
  FROM pos_transaction_payments
  WHERE transaction_id = p_transaction_id
    AND payment_method = 'cash'
    AND status != 'voided';

  IF v_cash_refund > 0 THEN
    UPDATE pos_shifts
    SET expected_cash = COALESCE(expected_cash, 0) - v_cash_refund,
        updated_at    = now()
    WHERE id = v_transaction.shift_id;
  END IF;

  -- Mark as voided
  UPDATE pos_transactions
  SET status      = 'voided',
      voided_by   = p_voided_by,
      voided_at   = now(),
      void_reason = p_void_reason,
      updated_at  = now()
  WHERE id = p_transaction_id;

  UPDATE pos_transaction_payments
  SET status = 'voided'
  WHERE transaction_id = p_transaction_id;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', p_transaction_id,
    'transaction_number', v_transaction.transaction_number,
    'voided_amount', v_transaction.total
  );
END;
$function$;

-- =========================================================================
-- STEP 2: Close cross-branch warehouse fallback in process_pos_transaction
-- =========================================================================
CREATE OR REPLACE FUNCTION public.process_pos_transaction(
  p_organization_id uuid,
  p_business_id uuid,
  p_register_id uuid,
  p_shift_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_subtotal numeric,
  p_tax_amount numeric,
  p_discount_amount numeric,
  p_total numeric,
  p_transaction_type text DEFAULT 'sale'::text,
  p_customer_id uuid DEFAULT NULL::uuid,
  p_customer_tin text DEFAULT NULL::text,
  p_customer_name text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
  p_cashier_id uuid DEFAULT NULL::uuid,
  p_created_by uuid DEFAULT NULL::uuid,
  p_original_transaction_id uuid DEFAULT NULL::uuid,
  p_tip_amount numeric DEFAULT 0,
  p_table_session_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_transaction_id uuid;
  v_transaction_number text;
  v_register_code text;
  v_register_branch_id uuid;
  v_register_business_id uuid;
  v_register_org_id uuid;
  v_shift_warehouse_id uuid;
  v_default_warehouse_id uuid;
  v_item jsonb;
  v_payment jsonb;
  v_product_id uuid;
  v_quantity numeric;
  v_track_inventory boolean;
  v_total_paid numeric := 0;
  v_cash_total numeric := 0;
  v_payment_status text := 'paid';
  v_item_index integer := 0;
BEGIN
  -- Single source of truth: register owns the (org, business, branch) tuple.
  SELECT register_code, branch_id, business_id, organization_id
    INTO v_register_code, v_register_branch_id, v_register_business_id, v_register_org_id
  FROM public.pos_registers
  WHERE id = p_register_id;

  IF v_register_code IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Register not found');
  END IF;

  IF v_register_org_id IS DISTINCT FROM p_organization_id
     OR v_register_business_id IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Register % belongs to a different organization/business than supplied (org=%, biz=% vs supplied org=%, biz=%)',
      p_register_id, v_register_org_id, v_register_business_id, p_organization_id, p_business_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_register_branch_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Register has no branch context');
  END IF;

  -- Warehouse: shift-locked → branch-default. NO business-wide fallback (A3).
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
  -- (Removed: business-wide is_default fallback that allowed cross-branch decrements.)

  SELECT COALESCE(SUM((p->>'amount')::numeric), 0)
    INTO v_total_paid
  FROM jsonb_array_elements(p_payments) p;

  IF v_total_paid < p_total AND p_transaction_type = 'sale' THEN
    v_payment_status := 'partial';
  END IF;

  v_transaction_number := public.get_next_pos_transaction_number(v_register_org_id, COALESCE(v_register_code, 'REG'));

  INSERT INTO public.pos_transactions (
    id, organization_id, business_id, branch_id, register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id,
    subtotal, tax_amount, discount_amount, total, tip_amount,
    payment_status, customer_id, customer_tin, customer_name,
    notes, cashier_id, created_by, table_session_id,
    status, completed_at, created_at
  ) VALUES (
    gen_random_uuid(), v_register_org_id, v_register_business_id, v_register_branch_id,
    p_register_id, p_shift_id, v_transaction_number,
    p_transaction_type, p_original_transaction_id,
    p_subtotal, p_tax_amount, p_discount_amount, p_total, COALESCE(p_tip_amount, 0),
    v_payment_status, p_customer_id, p_customer_tin, p_customer_name,
    p_notes, p_cashier_id, COALESCE(p_created_by, p_cashier_id), p_table_session_id,
    'completed', now(), now()
  ) RETURNING id INTO v_transaction_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_quantity   := (v_item->>'quantity')::numeric;

    INSERT INTO public.pos_transaction_items (
      transaction_id, product_id, description, quantity,
      unit_price, discount_type, discount_value,
      tax_rate, tax_amount, line_total, cost_price, sort_order,
      tax_rate_id, etims_tax_code
    ) VALUES (
      v_transaction_id, v_product_id, v_item->>'name', v_quantity,
      (v_item->>'unit_price')::numeric, v_item->>'discount_type',
      COALESCE((v_item->>'discount_value')::numeric, 0),
      COALESCE((v_item->>'tax_rate')::numeric, 0),
      COALESCE((v_item->>'tax_amount')::numeric, 0),
      (v_item->>'line_total')::numeric,
      COALESCE((v_item->>'cost_price')::numeric, 0),
      v_item_index,
      NULLIF(v_item->>'tax_rate_id', '')::uuid,
      v_item->>'etims_tax_code'
    );

    IF v_product_id IS NOT NULL THEN
      SELECT track_inventory INTO v_track_inventory
      FROM public.products
      WHERE id = v_product_id
        AND organization_id = v_register_org_id
        AND business_id     = v_register_business_id;

      IF v_track_inventory = true THEN
        IF v_default_warehouse_id IS NULL THEN
          RAISE EXCEPTION 'No active warehouse found for POS register branch % — create a branch warehouse before selling tracked inventory', v_register_branch_id
            USING ERRCODE = 'check_violation';
        END IF;

        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, unit_cost,
          reference_type, reference_id, notes, created_by, movement_date
        ) VALUES (
          v_register_org_id, v_register_business_id, v_register_branch_id,
          v_product_id, v_default_warehouse_id,
          CASE WHEN p_transaction_type = 'return' THEN 'pos_return' ELSE 'pos_sale' END,
          CASE WHEN p_transaction_type = 'return' THEN v_quantity ELSE -v_quantity END,
          COALESCE((v_item->>'cost_price')::numeric, 0),
          'pos_transaction', v_transaction_id,
          CASE WHEN p_transaction_type = 'return' THEN 'POS Return: ' ELSE 'POS Sale: ' END || v_transaction_number,
          COALESCE(p_created_by, p_cashier_id),
          now()
        );
      END IF;
    END IF;

    v_item_index := v_item_index + 1;
  END LOOP;

  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments)
  LOOP
    INSERT INTO public.pos_transaction_payments (
      transaction_id, payment_method, amount, reference,
      card_last_four, card_type, mpesa_receipt_number, status, processed_at
    ) VALUES (
      v_transaction_id,
      v_payment->>'payment_method',
      (v_payment->>'amount')::numeric,
      v_payment->>'reference',
      v_payment->>'card_last_four',
      v_payment->>'card_type',
      v_payment->>'mpesa_receipt_number',
      'completed',
      now()
    );

    IF v_payment->>'payment_method' = 'cash' THEN
      v_cash_total := v_cash_total + (v_payment->>'amount')::numeric;
    END IF;
  END LOOP;

  UPDATE public.pos_shifts SET
    total_sales        = total_sales + CASE WHEN p_transaction_type = 'sale'   THEN p_total ELSE 0 END,
    total_returns      = total_returns + CASE WHEN p_transaction_type = 'return' THEN p_total ELSE 0 END,
    total_transactions = total_transactions + 1,
    cash_payments      = cash_payments + v_cash_total,
    card_payments      = card_payments + (v_total_paid - v_cash_total),
    expected_cash      = COALESCE(expected_cash, 0) + v_cash_total,
    updated_at         = now()
  WHERE id = p_shift_id
    AND organization_id = v_register_org_id
    AND business_id     = v_register_business_id
    AND branch_id       = v_register_branch_id;

  DELETE FROM public.pos_stock_reservations WHERE register_id = p_register_id;

  IF p_table_session_id IS NOT NULL THEN
    UPDATE public.pos_table_sessions SET
      status       = 'completed',
      closed_at    = now(),
      total_amount = p_total,
      updated_at   = now()
    WHERE id = p_table_session_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'transaction_number', v_transaction_number,
    'change', GREATEST(0, v_total_paid - p_total),
    'branch_id', v_register_branch_id,
    'business_id', v_register_business_id
  );
END;
$function$;

-- =========================================================================
-- STEP 4: Lock stock_transfers company scope
-- =========================================================================
-- Backfill any existing NULL business_id rows from the source warehouse.
UPDATE public.stock_transfers st
SET business_id = w.business_id
FROM public.warehouses w
WHERE st.business_id IS NULL
  AND w.id = st.from_warehouse_id;

ALTER TABLE public.stock_transfers
  ALTER COLUMN business_id SET NOT NULL;

DROP POLICY IF EXISTS org_stock_transfers_select ON public.stock_transfers;
DROP POLICY IF EXISTS org_stock_transfers_insert ON public.stock_transfers;
DROP POLICY IF EXISTS org_stock_transfers_update ON public.stock_transfers;
DROP POLICY IF EXISTS org_stock_transfers_delete ON public.stock_transfers;

CREATE POLICY stock_transfers_select_v2 ON public.stock_transfers
  FOR SELECT TO authenticated
  USING (user_can_access_business(auth.uid(), business_id));

CREATE POLICY stock_transfers_insert_v2 ON public.stock_transfers
  FOR INSERT TO authenticated
  WITH CHECK (user_can_access_business(auth.uid(), business_id));

CREATE POLICY stock_transfers_update_v2 ON public.stock_transfers
  FOR UPDATE TO authenticated
  USING (user_can_access_business(auth.uid(), business_id))
  WITH CHECK (user_can_access_business(auth.uid(), business_id));

CREATE POLICY stock_transfers_delete_v2 ON public.stock_transfers
  FOR DELETE TO authenticated
  USING (user_can_access_business(auth.uid(), business_id));

-- =========================================================================
-- STEP 5: Branch-level RLS on stock tables
-- =========================================================================
-- warehouse_stock
DROP POLICY IF EXISTS warehouse_stock_select_v2 ON public.warehouse_stock;
CREATE POLICY warehouse_stock_select_v2 ON public.warehouse_stock
  FOR SELECT TO public
  USING (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'read')
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

-- stock_movements
DROP POLICY IF EXISTS stock_movements_select_v2 ON public.stock_movements;
CREATE POLICY stock_movements_select_v2 ON public.stock_movements
  FOR SELECT TO public
  USING (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'read')
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

-- stock_adjustments
DROP POLICY IF EXISTS stock_adjustments_select_v2 ON public.stock_adjustments;
CREATE POLICY stock_adjustments_select_v2 ON public.stock_adjustments
  FOR SELECT TO public
  USING (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'read')
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

-- =========================================================================
-- STEP 7: Drop orphan invoice → stock RPC
-- (Delivery notes via complete_delivery_atomic remain the sole sales-side
--  stock-consuming path, matching the documented model.)
-- =========================================================================
DROP FUNCTION IF EXISTS public.create_invoice_stock_movements(uuid, uuid, uuid, uuid);

-- =========================================================================
-- STEP 8: Reconcile reorder rules — drop unused warehouse_id scope
-- =========================================================================
ALTER TABLE public.product_reorder_rules
  DROP COLUMN IF EXISTS warehouse_id;