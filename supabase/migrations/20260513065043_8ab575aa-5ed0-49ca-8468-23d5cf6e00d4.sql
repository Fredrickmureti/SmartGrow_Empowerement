
-- 1) Schema: add tender vs allocation fields
ALTER TABLE public.pos_transaction_payments
  ADD COLUMN IF NOT EXISTS tendered_amount numeric,
  ADD COLUMN IF NOT EXISTS change_given numeric NOT NULL DEFAULT 0;

-- Backfill: pre-existing rows treated tender == applied with zero change
UPDATE public.pos_transaction_payments
   SET tendered_amount = amount
 WHERE tendered_amount IS NULL;

ALTER TABLE public.pos_transaction_payments
  ALTER COLUMN tendered_amount SET NOT NULL,
  ALTER COLUMN tendered_amount SET DEFAULT 0;

-- Invariant: tender must cover the applied amount; change can't be negative.
-- Cash is the only tender that can produce real change; for non-cash methods
-- callers should send tendered_amount = amount and change_given = 0.
ALTER TABLE public.pos_transaction_payments
  DROP CONSTRAINT IF EXISTS pos_transaction_payments_tender_invariants;
ALTER TABLE public.pos_transaction_payments
  ADD CONSTRAINT pos_transaction_payments_tender_invariants
  CHECK (
    tendered_amount >= amount
    AND change_given >= 0
    AND ABS((tendered_amount - amount) - change_given) < 0.005
  );

-- 2) process_pos_transaction: accept tendered_amount / change_given per line
CREATE OR REPLACE FUNCTION public.process_pos_transaction(
  p_organization_id uuid, p_business_id uuid, p_register_id uuid, p_shift_id uuid,
  p_items jsonb, p_payments jsonb,
  p_subtotal numeric, p_tax_amount numeric, p_discount_amount numeric, p_total numeric,
  p_transaction_type text DEFAULT 'sale'::text,
  p_customer_id uuid DEFAULT NULL::uuid, p_customer_tin text DEFAULT NULL::text,
  p_customer_name text DEFAULT NULL::text, p_notes text DEFAULT NULL::text,
  p_cashier_id uuid DEFAULT NULL::uuid, p_created_by uuid DEFAULT NULL::uuid,
  p_original_transaction_id uuid DEFAULT NULL::uuid,
  p_tip_amount numeric DEFAULT 0,
  p_table_session_id uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text)
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
  v_on_hand numeric;
  v_reserved numeric;
  v_total_paid numeric := 0;
  v_total_tendered numeric := 0;
  v_total_change numeric := 0;
  v_cash_total numeric := 0;
  v_payment_status text := 'paid';
  v_item_index integer := 0;
  v_existing record;
  v_insufficient jsonb := '[]'::jsonb;
  v_product_name text;
  v_currency text;
  v_snapshot jsonb;
  v_p_amount numeric;
  v_p_tendered numeric;
  v_p_change numeric;
  v_p_method text;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, transaction_number, branch_id, business_id, total
      INTO v_existing
    FROM public.pos_transactions
    WHERE organization_id = p_organization_id
      AND business_id     = p_business_id
      AND register_id     = p_register_id
      AND idempotency_key = p_idempotency_key
    LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', true, 'idempotent_replay', true,
        'transaction_id', v_existing.id,
        'transaction_number', v_existing.transaction_number,
        'change', 0,
        'branch_id', v_existing.branch_id,
        'business_id', v_existing.business_id
      );
    END IF;
  END IF;

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

  IF p_transaction_type = 'sale'
     AND COALESCE(p_total, 0) > 0
     AND (p_payments IS NULL OR jsonb_array_length(p_payments) = 0) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'no_payments',
      'detail', 'A sale with a positive total requires at least one payment line.'
    );
  END IF;

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
      AND COALESCE(is_in_transit, false) = false
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1;
  END IF;

  IF p_transaction_type <> 'return' AND v_default_warehouse_id IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
      v_quantity   := COALESCE((v_item->>'quantity')::numeric, 0);
      IF v_product_id IS NULL OR v_quantity <= 0 THEN CONTINUE; END IF;

      SELECT track_inventory, COALESCE(NULLIF(name,''), '') INTO v_track_inventory, v_product_name
      FROM public.products
      WHERE id = v_product_id
        AND organization_id = v_register_org_id
        AND business_id     = v_register_business_id;

      IF v_track_inventory IS NOT TRUE THEN CONTINUE; END IF;

      SELECT
        COALESCE(SUM(sm.quantity), 0),
        COALESCE((SELECT SUM(qty) FROM public.pos_stock_reservations
                   WHERE register_id = p_register_id
                     AND product_id = v_product_id), 0)
      INTO v_on_hand, v_reserved
      FROM public.stock_movements sm
      WHERE sm.product_id = v_product_id
        AND sm.warehouse_id = v_default_warehouse_id;

      IF v_on_hand - v_reserved < v_quantity THEN
        v_insufficient := v_insufficient || jsonb_build_object(
          'product_id', v_product_id,
          'product_name', v_product_name,
          'requested', v_quantity,
          'available', GREATEST(0, v_on_hand - v_reserved)
        );
      END IF;
    END LOOP;
  END IF;

  IF jsonb_array_length(v_insufficient) > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_stock', 'details', v_insufficient);
  END IF;

  -- Pre-pass payments to compute totals + validate tender/change
  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments)
  LOOP
    v_p_method   := v_payment->>'payment_method';
    v_p_amount   := COALESCE((v_payment->>'amount')::numeric, 0);
    v_p_tendered := COALESCE((v_payment->>'tendered_amount')::numeric, v_p_amount);
    v_p_change   := COALESCE((v_payment->>'change_given')::numeric, GREATEST(0, v_p_tendered - v_p_amount));

    IF v_p_tendered < v_p_amount - 0.005 THEN
      RAISE EXCEPTION 'Payment line % has tendered (%) less than applied (%)', v_p_method, v_p_tendered, v_p_amount
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_p_method <> 'cash' AND v_p_change > 0.005 THEN
      RAISE EXCEPTION 'Non-cash payment % cannot return change (%)', v_p_method, v_p_change
        USING ERRCODE = 'check_violation';
    END IF;

    v_total_paid     := v_total_paid + v_p_amount;
    v_total_tendered := v_total_tendered + v_p_tendered;
    v_total_change   := v_total_change + v_p_change;
    IF v_p_method = 'cash' THEN
      v_cash_total := v_cash_total + v_p_amount;
    END IF;
  END LOOP;

  v_payment_status := CASE WHEN v_total_paid + 0.005 >= COALESCE(p_total, 0) THEN 'paid' ELSE 'partial' END;

  v_transaction_number := public.get_next_pos_transaction_number(p_organization_id, COALESCE(v_register_code, 'REG'));
  v_snapshot := jsonb_build_object('items', p_items, 'payments', p_payments);

  INSERT INTO public.pos_transactions (
    id, organization_id, business_id, branch_id,
    register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id,
    subtotal, tax_amount, discount_amount, total, tip_amount,
    payment_status, customer_id, customer_tin, customer_name,
    notes, cashier_id, created_by, table_session_id,
    status, completed_at, created_at, idempotency_key, snapshot
  ) VALUES (
    gen_random_uuid(), v_register_org_id, v_register_business_id, v_register_branch_id,
    p_register_id, p_shift_id, v_transaction_number,
    p_transaction_type, p_original_transaction_id,
    p_subtotal, p_tax_amount, p_discount_amount, p_total, COALESCE(p_tip_amount, 0),
    v_payment_status, p_customer_id, p_customer_tin, p_customer_name,
    p_notes, p_cashier_id, COALESCE(p_created_by, p_cashier_id), p_table_session_id,
    'completed', now(), now(), p_idempotency_key, v_snapshot
  ) RETURNING id INTO v_transaction_id;

  v_item_index := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
    v_quantity   := COALESCE((v_item->>'quantity')::numeric, 0);

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
    v_p_method   := v_payment->>'payment_method';
    v_p_amount   := COALESCE((v_payment->>'amount')::numeric, 0);
    v_p_tendered := COALESCE((v_payment->>'tendered_amount')::numeric, v_p_amount);
    v_p_change   := COALESCE((v_payment->>'change_given')::numeric, GREATEST(0, v_p_tendered - v_p_amount));

    INSERT INTO public.pos_transaction_payments (
      transaction_id, payment_method, amount, tendered_amount, change_given, reference,
      card_last_four, card_type, mpesa_receipt_number, status, processed_at
    ) VALUES (
      v_transaction_id,
      v_p_method,
      v_p_amount,
      v_p_tendered,
      v_p_change,
      v_payment->>'reference',
      v_payment->>'card_last_four',
      v_payment->>'card_type',
      v_payment->>'mpesa_receipt_number',
      'completed',
      now()
    );
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
      status = 'completed', closed_at = now(),
      total_amount = p_total, updated_at = now()
    WHERE id = p_table_session_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'idempotent_replay', false,
    'transaction_id', v_transaction_id,
    'transaction_number', v_transaction_number,
    'change', v_total_change,
    'tendered', v_total_tendered,
    'branch_id', v_register_branch_id,
    'business_id', v_register_business_id
  );
END;
$function$;

-- 3) finalize_table_order (with p_created_by) — pass tender/change through
CREATE OR REPLACE FUNCTION public.finalize_table_order(
  p_transaction_id uuid, p_payments jsonb,
  p_tip_amount numeric DEFAULT 0,
  p_created_by uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_txn RECORD;
  v_payment JSONB;
  v_total_paid NUMERIC := 0;
  v_total_tendered NUMERIC := 0;
  v_total_change NUMERIC := 0;
  v_payment_status TEXT;
  v_track_inventory BOOLEAN;
  v_available_stock NUMERIC;
  v_insufficient_stock JSONB := '[]'::JSONB;
  v_item RECORD;
  v_register_code TEXT;
  v_final_txn_number TEXT;
  v_p_amount NUMERIC;
  v_p_tendered NUMERIC;
  v_p_change NUMERIC;
  v_p_method TEXT;
BEGIN
  SELECT * INTO v_txn FROM pos_transactions WHERE id = p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'transaction_not_found');
  END IF;
  IF v_txn.status != 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'transaction_not_pending', 'details', 'Transaction status is: ' || v_txn.status);
  END IF;

  FOR v_item IN SELECT * FROM pos_transaction_items WHERE transaction_id = p_transaction_id
  LOOP
    IF v_item.product_id IS NOT NULL THEN
      SELECT track_inventory, stock_quantity INTO v_track_inventory, v_available_stock
      FROM products WHERE id = v_item.product_id FOR UPDATE;
      IF v_track_inventory = true AND COALESCE(v_available_stock, 0) < v_item.quantity THEN
        v_insufficient_stock := v_insufficient_stock || jsonb_build_object(
          'product_id', v_item.product_id,
          'product_name', v_item.description,
          'requested', v_item.quantity,
          'available', COALESCE(v_available_stock, 0)
        );
      END IF;
    END IF;
  END LOOP;

  IF jsonb_array_length(v_insufficient_stock) > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_stock', 'details', v_insufficient_stock);
  END IF;

  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments)
  LOOP
    v_p_method   := v_payment->>'payment_method';
    v_p_amount   := COALESCE((v_payment->>'amount')::NUMERIC, 0);
    v_p_tendered := COALESCE((v_payment->>'tendered_amount')::NUMERIC, v_p_amount);
    v_p_change   := COALESCE((v_payment->>'change_given')::NUMERIC, GREATEST(0, v_p_tendered - v_p_amount));

    IF v_p_tendered < v_p_amount - 0.005 THEN
      RAISE EXCEPTION 'Payment line % has tendered (%) less than applied (%)', v_p_method, v_p_tendered, v_p_amount
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_p_method <> 'cash' AND v_p_change > 0.005 THEN
      RAISE EXCEPTION 'Non-cash payment % cannot return change (%)', v_p_method, v_p_change
        USING ERRCODE = 'check_violation';
    END IF;

    v_total_paid     := v_total_paid + v_p_amount;
    v_total_tendered := v_total_tendered + v_p_tendered;
    v_total_change   := v_total_change + v_p_change;
  END LOOP;

  v_payment_status := CASE WHEN v_total_paid >= v_txn.total THEN 'paid' ELSE 'partial' END;

  SELECT register_code INTO v_register_code FROM pos_registers WHERE id = v_txn.register_id;
  v_final_txn_number := get_next_pos_transaction_number(v_txn.organization_id, COALESCE(v_register_code, 'REG'));

  UPDATE pos_transactions SET
    status = 'completed',
    payment_status = v_payment_status,
    completed_at = now(),
    tip_amount = COALESCE(p_tip_amount, 0),
    transaction_number = v_final_txn_number,
    updated_at = now(),
    version = version + 1
  WHERE id = p_transaction_id;

  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments)
  LOOP
    v_p_method   := v_payment->>'payment_method';
    v_p_amount   := COALESCE((v_payment->>'amount')::NUMERIC, 0);
    v_p_tendered := COALESCE((v_payment->>'tendered_amount')::NUMERIC, v_p_amount);
    v_p_change   := COALESCE((v_payment->>'change_given')::NUMERIC, GREATEST(0, v_p_tendered - v_p_amount));

    INSERT INTO pos_transaction_payments (
      transaction_id, payment_method, amount, tendered_amount, change_given, reference,
      card_last_four, card_type, mpesa_receipt_number, status
    ) VALUES (
      p_transaction_id,
      v_p_method,
      v_p_amount,
      v_p_tendered,
      v_p_change,
      v_payment->>'reference',
      v_payment->>'card_last_four',
      v_payment->>'card_type',
      CASE WHEN v_p_method = 'mobile_money' THEN v_payment->>'reference' ELSE NULL END,
      'completed'
    );
  END LOOP;

  FOR v_item IN SELECT * FROM pos_transaction_items WHERE transaction_id = p_transaction_id
  LOOP
    IF v_item.product_id IS NOT NULL THEN
      SELECT track_inventory INTO v_track_inventory FROM products WHERE id = v_item.product_id;
      IF v_track_inventory = true THEN
        UPDATE products
          SET stock_quantity = GREATEST(0, COALESCE(stock_quantity, 0) - v_item.quantity),
              updated_at = now()
          WHERE id = v_item.product_id;
      END IF;
    END IF;
  END LOOP;

  UPDATE pos_shifts SET
    total_sales = COALESCE(total_sales, 0) + v_txn.total,
    transaction_count = COALESCE(transaction_count, 0) + 1,
    total_tax = COALESCE(total_tax, 0) + v_txn.tax_amount,
    total_discount = COALESCE(total_discount, 0) + COALESCE(v_txn.discount_amount, 0),
    total_tips = COALESCE(total_tips, 0) + COALESCE(p_tip_amount, 0),
    updated_at = now()
  WHERE id = v_txn.shift_id;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', p_transaction_id,
    'transaction_number', v_final_txn_number,
    'change', v_total_change,
    'tendered', v_total_tendered
  );
END;
$function$;

-- 4) Snapshot builder: expose tender/change to receipts, customer display, PDFs
CREATE OR REPLACE FUNCTION public._pos_build_receipt_snapshot(p_tx_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH tx AS (
    SELECT * FROM public.pos_transactions WHERE id = p_tx_id
  ),
  items AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id', ti.id,
      'product_id', ti.product_id,
      'product_name', COALESCE(NULLIF(p.name, ''), NULLIF(ti.description, ''), 'Item'),
      'description', ti.description,
      'sku', p.sku,
      'quantity', ti.quantity,
      'unit_price', ti.unit_price,
      'discount_type', ti.discount_type,
      'discount_value', ti.discount_value,
      'discount_amount', CASE
        WHEN ti.discount_type = 'percentage' THEN ROUND((ti.unit_price * ti.quantity * COALESCE(ti.discount_value,0) / 100.0)::numeric, 2)
        WHEN ti.discount_type = 'fixed' THEN COALESCE(ti.discount_value, 0)
        ELSE 0
      END,
      'tax_rate', ti.tax_rate,
      'tax_rate_name', tr.name,
      'tax_amount', ti.tax_amount,
      'line_total', ti.line_total,
      'sort_order', ti.sort_order,
      'cost_price', ti.cost_price,
      'etims_tax_code', ti.etims_tax_code
    ) ORDER BY ti.sort_order, ti.id) AS items
    FROM public.pos_transaction_items ti
    LEFT JOIN public.products p ON p.id = ti.product_id
    LEFT JOIN public.tax_rates tr ON tr.id = ti.tax_rate_id
    WHERE ti.transaction_id = p_tx_id
  ),
  payments AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id', tp.id,
      'payment_method', tp.payment_method,
      'amount', tp.amount,
      'tendered_amount', tp.tendered_amount,
      'change_given', tp.change_given,
      'reference', tp.reference,
      'created_at', tp.created_at
    ) ORDER BY tp.created_at) AS payments
    FROM public.pos_transaction_payments tp
    WHERE tp.transaction_id = p_tx_id
  ),
  business AS (
    SELECT to_jsonb(b.*) AS business, b.receipt_settings AS biz_receipt_settings
    FROM tx JOIN public.businesses b ON b.id = tx.business_id
  ),
  branch AS (
    SELECT to_jsonb(br.*) AS branch
    FROM tx LEFT JOIN public.branches br ON br.id = tx.branch_id
  ),
  org AS (
    SELECT to_jsonb(o.*) AS organization
    FROM tx JOIN public.organizations o ON o.id = tx.organization_id
  ),
  customer AS (
    SELECT to_jsonb(c.*) AS customer
    FROM tx LEFT JOIN public.contacts c ON c.id = tx.customer_id
  ),
  cashier AS (
    SELECT jsonb_build_object(
      'id', tx.cashier_id,
      'name', p.full_name,
      'email', p.email
    ) AS cashier
    FROM tx LEFT JOIN public.profiles p ON p.id = tx.cashier_id
  ),
  register AS (
    SELECT to_jsonb(r.*) AS register
    FROM tx LEFT JOIN public.pos_registers r ON r.id = tx.register_id
  ),
  reg_settings AS (
    SELECT COALESCE(
      (SELECT ps.setting_value
         FROM public.pos_settings ps, tx
        WHERE ps.business_id = tx.business_id
          AND ps.setting_key = 'receipt_settings'
          AND ps.register_id = tx.register_id
        LIMIT 1),
      (SELECT ps.setting_value
         FROM public.pos_settings ps, tx
        WHERE ps.business_id = tx.business_id
          AND ps.setting_key = 'receipt_settings'
          AND ps.register_id IS NULL
          AND ps.branch_id = tx.branch_id
        LIMIT 1),
      (SELECT ps.setting_value
         FROM public.pos_settings ps, tx
        WHERE ps.business_id = tx.business_id
          AND ps.setting_key = 'receipt_settings'
          AND ps.register_id IS NULL
          AND ps.branch_id IS NULL
        LIMIT 1)
    ) AS register_receipt_settings
  )
  SELECT jsonb_build_object(
    'schema_version', 4,
    'transaction', to_jsonb(tx.*),
    'items',       COALESCE(items.items, '[]'::jsonb),
    'payments',    COALESCE(payments.payments, '[]'::jsonb),
    'business',    business.business,
    'branch',      branch.branch,
    'organization', org.organization,
    'customer',    customer.customer,
    'cashier',     cashier.cashier,
    'register',    register.register,
    'business_receipt_settings', business.biz_receipt_settings,
    'register_receipt_settings', reg_settings.register_receipt_settings
  )
  FROM tx, items, payments, business, branch, org, customer, cashier, register, reg_settings;
$function$;
