-- POS multi-entity hardening: stock movement branch stamping and legacy report RPC retirement

CREATE OR REPLACE FUNCTION public.enforce_stock_movement_branch_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_warehouse RECORD;
BEGIN
  IF NEW.warehouse_id IS NOT NULL THEN
    SELECT id, organization_id, business_id, branch_id
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

    IF NEW.branch_id IS NULL THEN
      NEW.branch_id := v_warehouse.branch_id;
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
$$;

DROP TRIGGER IF EXISTS trg_enforce_stock_movement_branch_scope ON public.stock_movements;
CREATE TRIGGER trg_enforce_stock_movement_branch_scope
BEFORE INSERT OR UPDATE OF organization_id, business_id, branch_id, warehouse_id
ON public.stock_movements
FOR EACH ROW
EXECUTE FUNCTION public.enforce_stock_movement_branch_scope();

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
AS $$
DECLARE
  v_transaction_id uuid;
  v_transaction_number text;
  v_register_code text;
  v_register_branch_id uuid;
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
  SELECT register_code, branch_id
  INTO v_register_code, v_register_branch_id
  FROM public.pos_registers
  WHERE id = p_register_id
    AND organization_id = p_organization_id
    AND business_id = p_business_id;

  IF v_register_code IS NULL OR v_register_branch_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Register not found or missing branch context');
  END IF;

  SELECT id INTO v_default_warehouse_id
  FROM public.warehouses
  WHERE organization_id = p_organization_id
    AND business_id = p_business_id
    AND branch_id = v_register_branch_id
    AND is_active = true
  ORDER BY is_default DESC, created_at ASC
  LIMIT 1;

  IF v_default_warehouse_id IS NULL THEN
    SELECT id INTO v_default_warehouse_id
    FROM public.warehouses
    WHERE organization_id = p_organization_id
      AND business_id = p_business_id
      AND is_default = true
      AND is_active = true
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  SELECT COALESCE(SUM((p->>'amount')::numeric), 0)
  INTO v_total_paid
  FROM jsonb_array_elements(p_payments) p;

  IF v_total_paid < p_total AND p_transaction_type = 'sale' THEN
    v_payment_status := 'partial';
  END IF;

  v_transaction_number := public.get_next_pos_transaction_number(p_organization_id, COALESCE(v_register_code, 'REG'));

  INSERT INTO public.pos_transactions (
    id, organization_id, business_id, branch_id, register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id,
    subtotal, tax_amount, discount_amount, total, tip_amount,
    payment_status, customer_id, customer_tin, customer_name,
    notes, cashier_id, created_by, table_session_id,
    status, completed_at, created_at
  ) VALUES (
    gen_random_uuid(), p_organization_id, p_business_id, v_register_branch_id, p_register_id, p_shift_id, v_transaction_number,
    p_transaction_type, p_original_transaction_id,
    p_subtotal, p_tax_amount, p_discount_amount, p_total, COALESCE(p_tip_amount, 0),
    v_payment_status, p_customer_id, p_customer_tin, p_customer_name,
    p_notes, p_cashier_id, COALESCE(p_created_by, p_cashier_id), p_table_session_id,
    'completed', now(), now()
  ) RETURNING id INTO v_transaction_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_quantity := (v_item->>'quantity')::numeric;

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
        AND organization_id = p_organization_id
        AND business_id = p_business_id;

      IF v_track_inventory = true THEN
        IF v_default_warehouse_id IS NULL THEN
          RAISE EXCEPTION 'No active warehouse found for POS register branch %', v_register_branch_id
            USING ERRCODE = 'check_violation';
        END IF;

        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, unit_cost,
          reference_type, reference_id, notes, created_by, movement_date
        ) VALUES (
          p_organization_id, p_business_id, v_register_branch_id, v_product_id, v_default_warehouse_id,
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
    total_sales = total_sales + CASE WHEN p_transaction_type = 'sale' THEN p_total ELSE 0 END,
    total_returns = total_returns + CASE WHEN p_transaction_type = 'return' THEN p_total ELSE 0 END,
    total_transactions = total_transactions + 1,
    cash_payments = cash_payments + v_cash_total,
    card_payments = card_payments + (v_total_paid - v_cash_total),
    expected_cash = COALESCE(expected_cash, 0) + v_cash_total,
    updated_at = now()
  WHERE id = p_shift_id
    AND organization_id = p_organization_id
    AND business_id = p_business_id
    AND branch_id = v_register_branch_id;

  DELETE FROM public.pos_stock_reservations WHERE register_id = p_register_id;

  IF p_table_session_id IS NOT NULL THEN
    UPDATE public.pos_table_sessions SET
      status = 'completed',
      closed_at = now(),
      total_amount = p_total,
      updated_at = now()
    WHERE id = p_table_session_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'transaction_number', v_transaction_number,
    'change', GREATEST(0, v_total_paid - p_total),
    'branch_id', v_register_branch_id
  );
END;
$$;

DROP FUNCTION IF EXISTS public.get_pos_daily_sales(uuid, uuid, date, date, uuid);
DROP FUNCTION IF EXISTS public.get_pos_hourly_sales(uuid, uuid, date, uuid);
DROP FUNCTION IF EXISTS public.get_pos_top_products(uuid, uuid, date, date, uuid, integer);
DROP FUNCTION IF EXISTS public.get_pos_dashboard_stats(uuid, uuid, date);

CREATE INDEX IF NOT EXISTS idx_stock_movements_pos_scope
ON public.stock_movements (organization_id, business_id, branch_id, reference_type, reference_id);

CREATE INDEX IF NOT EXISTS idx_pos_sessions_register_scope
ON public.pos_sessions (organization_id, business_id, branch_id, register_id, status);