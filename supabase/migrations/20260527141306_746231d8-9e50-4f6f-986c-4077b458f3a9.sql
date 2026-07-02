
-- ============== A1: Backfill base/sales/purchase UoM ==============
DO $a1$
DECLARE v_biz RECORD; v_piece uuid;
BEGIN
  FOR v_biz IN SELECT id FROM public.businesses LOOP
    PERFORM public.seed_default_uom_for_business(v_biz.id);
    SELECT id INTO v_piece FROM public.units_of_measure
      WHERE business_id = v_biz.id AND code = 'PCE' LIMIT 1;
    IF v_piece IS NULL THEN CONTINUE; END IF;
    UPDATE public.products
       SET base_uom_id     = COALESCE(base_uom_id, v_piece),
           sales_uom_id    = COALESCE(sales_uom_id, COALESCE(base_uom_id, v_piece)),
           purchase_uom_id = COALESCE(purchase_uom_id, COALESCE(base_uom_id, v_piece))
     WHERE business_id = v_biz.id
       AND (base_uom_id IS NULL OR sales_uom_id IS NULL OR purchase_uom_id IS NULL);
  END LOOP;
END $a1$;

-- ============== A3: Unify packaging models ==============
INSERT INTO public.product_packaging (
  organization_id, business_id, product_id, name, qty_in_base_uom, barcode_id
)
SELECT pi.organization_id, pi.business_id, pi.product_id,
       'Pack of ' || pi.pack_quantity::text,
       pi.pack_quantity,
       pi.id
FROM public.product_identifiers pi
WHERE pi.kind = 'pack'
  AND pi.pack_quantity IS NOT NULL
  AND pi.pack_quantity > 0
  AND NOT EXISTS (
    SELECT 1 FROM public.product_packaging pk
     WHERE pk.product_id = pi.product_id
       AND pk.qty_in_base_uom = pi.pack_quantity
  )
ON CONFLICT (product_id, name) DO NOTHING;

-- ============== A3: pos_resolve_barcode prefers product_packaging ==============
DROP FUNCTION IF EXISTS public.pos_resolve_barcode(uuid, uuid, text);

CREATE FUNCTION public.pos_resolve_barcode(p_business_id uuid, p_branch_id uuid, p_code text)
 RETURNS TABLE(
   product_id uuid, name text, sku text, selling_price numeric, cost_price numeric,
   tax_rate numeric, tax_rate_id uuid, tax_rate_name text, etims_tax_code text,
   category_id uuid, category_name text, branch_on_hand numeric,
   matched_kind product_identifier_kind, matched_code text,
   matched_rule_kind pos_barcode_rule_kind, scan_quantity numeric,
   scan_weight numeric, embedded_price numeric, is_weighted boolean,
   packaging_id uuid, base_uom_id uuid
 )
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_code text := trim(p_code);
  v_rule public.pos_barcode_rules%ROWTYPE;
  v_item_code text; v_embedded numeric;
  v_qty numeric := 1; v_weight numeric := NULL; v_price numeric := NULL;
  v_rule_kind public.pos_barcode_rule_kind := NULL;
  v_pid uuid; v_identifier_id uuid;
  v_matched_kind public.product_identifier_kind; v_matched_code text;
  v_pack_qty numeric;
  v_packaging_id uuid; v_pack_base_qty numeric;
BEGIN
  IF v_code IS NULL OR length(v_code) = 0 THEN RETURN; END IF;

  SELECT * INTO v_rule
  FROM public.pos_barcode_rules r
  WHERE r.business_id = p_business_id AND r.is_active = true
    AND length(v_code) = r.total_length
    AND substring(v_code FROM 1 FOR length(r.prefix)) = r.prefix
  ORDER BY length(r.prefix) DESC LIMIT 1;

  IF FOUND THEN
    v_rule_kind := v_rule.kind;
    v_item_code := substring(v_code FROM v_rule.item_code_start FOR v_rule.item_code_length);
    IF v_rule.embedded_value_start IS NOT NULL AND v_rule.embedded_value_length IS NOT NULL THEN
      BEGIN
        v_embedded := substring(v_code FROM v_rule.embedded_value_start FOR v_rule.embedded_value_length)::numeric
                      / NULLIF(v_rule.embedded_value_divisor, 0);
      EXCEPTION WHEN OTHERS THEN v_embedded := NULL; END;
      IF v_rule.kind = 'weighted_price' THEN v_price := v_embedded;
      ELSIF v_rule.kind = 'weighted_qty' THEN v_weight := v_embedded; END IF;
    END IF;

    SELECT pi.id, pi.product_id, pi.kind, pi.code, pi.pack_quantity
      INTO v_identifier_id, v_pid, v_matched_kind, v_matched_code, v_pack_qty
    FROM public.product_identifiers pi
    WHERE pi.business_id = p_business_id
      AND lower(pi.code) = lower(v_item_code)
    LIMIT 1;
  END IF;

  IF v_pid IS NULL THEN
    SELECT pi.id, pi.product_id, pi.kind, pi.code, pi.pack_quantity
      INTO v_identifier_id, v_pid, v_matched_kind, v_matched_code, v_pack_qty
    FROM public.product_identifiers pi
    WHERE pi.business_id = p_business_id
      AND lower(pi.code) = lower(v_code)
    LIMIT 1;
  END IF;

  IF v_pid IS NULL THEN
    SELECT p.id, NULL::uuid, 'sku'::public.product_identifier_kind, p.sku, NULL::numeric
      INTO v_pid, v_identifier_id, v_matched_kind, v_matched_code, v_pack_qty
    FROM public.products p
    WHERE p.business_id = p_business_id AND p.is_active = true
      AND p.sku IS NOT NULL AND lower(trim(p.sku)) = lower(v_code)
    LIMIT 1;
  END IF;

  IF v_pid IS NULL THEN RETURN; END IF;

  IF v_identifier_id IS NOT NULL THEN
    SELECT pk.id, pk.qty_in_base_uom INTO v_packaging_id, v_pack_base_qty
    FROM public.product_packaging pk
    WHERE pk.barcode_id = v_identifier_id
    LIMIT 1;
  END IF;

  IF v_packaging_id IS NOT NULL THEN
    v_qty := v_pack_base_qty;
  ELSIF v_matched_kind = 'pack' AND v_pack_qty IS NOT NULL AND v_pack_qty > 0 THEN
    v_qty := v_pack_qty;
  END IF;

  RETURN QUERY
  SELECT
    p.id, p.name::text, p.sku::text, p.unit_price, p.cost_price,
    COALESCE(tr.rate, p.tax_rate), COALESCE(tr.id, p.tax_rate_id),
    tr.name::text, tr.etims_tax_code::text,
    p.category_id, pc.name::text,
    COALESCE((SELECT ws.quantity FROM public.warehouse_stock ws
              WHERE ws.product_id = p.id AND ws.branch_id = p_branch_id LIMIT 1), 0)::numeric,
    v_matched_kind, v_matched_code::text, v_rule_kind,
    v_qty, v_weight, v_price,
    COALESCE(p.is_weighted, false),
    v_packaging_id, p.base_uom_id
  FROM public.products p
  LEFT JOIN public.tax_rates tr ON tr.id = p.tax_rate_id
  LEFT JOIN public.product_categories pc ON pc.id = p.category_id
  WHERE p.id = v_pid AND p.is_active = true;
END
$function$;

-- ============== B5: process_pos_transaction propagates packaging ==============
CREATE OR REPLACE FUNCTION public.process_pos_transaction(
  p_organization_id uuid, p_business_id uuid, p_register_id uuid, p_shift_id uuid,
  p_items jsonb, p_payments jsonb, p_subtotal numeric, p_tax_amount numeric,
  p_discount_amount numeric, p_total numeric, p_transaction_type text DEFAULT 'sale',
  p_customer_id uuid DEFAULT NULL, p_customer_tin text DEFAULT NULL,
  p_customer_name text DEFAULT NULL, p_notes text DEFAULT NULL,
  p_cashier_id uuid DEFAULT NULL, p_created_by uuid DEFAULT NULL,
  p_original_transaction_id uuid DEFAULT NULL, p_tip_amount numeric DEFAULT 0,
  p_table_session_id uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_transaction_id uuid; v_transaction_number text; v_register_code text;
  v_register_branch_id uuid; v_register_business_id uuid; v_register_org_id uuid;
  v_shift_warehouse_id uuid; v_default_warehouse_id uuid;
  v_item jsonb; v_payment jsonb; v_product_id uuid; v_quantity numeric;
  v_track_inventory boolean; v_on_hand numeric; v_reserved numeric;
  v_total_paid numeric := 0; v_total_tendered numeric := 0; v_total_change numeric := 0;
  v_cash_total numeric := 0; v_payment_status text := 'paid';
  v_item_index integer := 0; v_existing record; v_insufficient jsonb := '[]'::jsonb;
  v_product_name text; v_snapshot jsonb;
  v_p_amount numeric; v_p_tendered numeric; v_p_change numeric; v_p_method text;
  v_packaging_id uuid; v_display_uom_id uuid; v_display_quantity numeric;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, transaction_number, branch_id, business_id, total INTO v_existing
    FROM public.pos_transactions
    WHERE organization_id = p_organization_id AND business_id = p_business_id
      AND register_id = p_register_id AND idempotency_key = p_idempotency_key LIMIT 1;
    IF v_existing.id IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'idempotent_replay', true,
        'transaction_id', v_existing.id, 'transaction_number', v_existing.transaction_number,
        'change', 0, 'branch_id', v_existing.branch_id, 'business_id', v_existing.business_id);
    END IF;
  END IF;

  SELECT register_code, branch_id, business_id, organization_id
    INTO v_register_code, v_register_branch_id, v_register_business_id, v_register_org_id
  FROM public.pos_registers WHERE id = p_register_id;

  IF v_register_code IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Register not found'); END IF;
  IF v_register_org_id IS DISTINCT FROM p_organization_id
     OR v_register_business_id IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Register % belongs to a different organization/business than supplied (org=%, biz=% vs supplied org=%, biz=%)',
      p_register_id, v_register_org_id, v_register_business_id, p_organization_id, p_business_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_register_branch_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Register has no branch context'); END IF;

  PERFORM public.assert_pos_caller_branch_access(v_register_branch_id);

  IF p_transaction_type = 'sale' AND COALESCE(p_total, 0) > 0
     AND (p_payments IS NULL OR jsonb_array_length(p_payments) = 0) THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_payments',
      'detail', 'A sale with a positive total requires at least one payment line.');
  END IF;

  SELECT warehouse_id INTO v_shift_warehouse_id FROM public.pos_shifts
  WHERE id = p_shift_id AND organization_id = v_register_org_id
    AND business_id = v_register_business_id AND register_id = p_register_id;
  v_default_warehouse_id := v_shift_warehouse_id;
  IF v_default_warehouse_id IS NULL THEN
    SELECT id INTO v_default_warehouse_id FROM public.warehouses
     WHERE organization_id = v_register_org_id AND business_id = v_register_business_id
       AND branch_id = v_register_branch_id AND is_active = true
       AND COALESCE(is_in_transit, false) = false
     ORDER BY is_default DESC, created_at ASC LIMIT 1;
  END IF;

  IF p_transaction_type <> 'return' AND v_default_warehouse_id IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
      v_quantity := COALESCE((v_item->>'quantity')::numeric, 0);
      IF v_product_id IS NULL OR v_quantity <= 0 THEN CONTINUE; END IF;
      SELECT track_inventory, COALESCE(NULLIF(name,''), '') INTO v_track_inventory, v_product_name
      FROM public.products WHERE id = v_product_id
        AND organization_id = v_register_org_id AND business_id = v_register_business_id;
      IF v_track_inventory IS NOT TRUE THEN CONTINUE; END IF;
      SELECT COALESCE(SUM(sm.quantity), 0),
        COALESCE((SELECT SUM(quantity) FROM public.pos_stock_reservations
                   WHERE register_id = p_register_id AND product_id = v_product_id), 0)
      INTO v_on_hand, v_reserved FROM public.stock_movements sm
      WHERE sm.product_id = v_product_id AND sm.warehouse_id = v_default_warehouse_id;
      IF v_on_hand - v_reserved < v_quantity THEN
        v_insufficient := v_insufficient || jsonb_build_object(
          'product_id', v_product_id, 'product_name', v_product_name,
          'requested', v_quantity, 'available', GREATEST(0, v_on_hand - v_reserved));
      END IF;
    END LOOP;
  END IF;
  IF jsonb_array_length(v_insufficient) > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_stock', 'details', v_insufficient);
  END IF;

  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments) LOOP
    v_p_method := v_payment->>'payment_method';
    v_p_amount := COALESCE((v_payment->>'amount')::numeric, 0);
    v_p_tendered := COALESCE((v_payment->>'tendered_amount')::numeric, v_p_amount);
    v_p_change := COALESCE((v_payment->>'change_given')::numeric, GREATEST(0, v_p_tendered - v_p_amount));
    IF v_p_tendered < v_p_amount - 0.005 THEN
      RAISE EXCEPTION 'Payment line % has tendered (%) less than applied (%)', v_p_method, v_p_tendered, v_p_amount
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_p_method <> 'cash' AND v_p_change > 0.005 THEN
      RAISE EXCEPTION 'Non-cash payment % cannot return change (%)', v_p_method, v_p_change
        USING ERRCODE = 'check_violation';
    END IF;
    v_total_paid := v_total_paid + v_p_amount;
    v_total_tendered := v_total_tendered + v_p_tendered;
    v_total_change := v_total_change + v_p_change;
    IF v_p_method = 'cash' THEN v_cash_total := v_cash_total + v_p_amount; END IF;
  END LOOP;
  v_payment_status := CASE WHEN v_total_paid + 0.005 >= COALESCE(p_total, 0) THEN 'paid' ELSE 'partial' END;
  v_transaction_number := public.get_next_pos_transaction_number(p_organization_id, COALESCE(v_register_code, 'REG'));
  v_snapshot := jsonb_build_object('items', p_items, 'payments', p_payments, 'committed_at', now());

  INSERT INTO public.pos_transactions (
    id, organization_id, business_id, branch_id, register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id, subtotal, tax_amount, discount_amount, total, tip_amount,
    payment_status, customer_id, customer_tin, customer_name, notes, cashier_id, created_by,
    table_session_id, status, completed_at, created_at, idempotency_key, snapshot
  ) VALUES (
    gen_random_uuid(), v_register_org_id, v_register_business_id, v_register_branch_id,
    p_register_id, p_shift_id, v_transaction_number, p_transaction_type, p_original_transaction_id,
    p_subtotal, p_tax_amount, p_discount_amount, p_total, COALESCE(p_tip_amount, 0),
    v_payment_status, p_customer_id, p_customer_tin, p_customer_name, p_notes,
    p_cashier_id, COALESCE(p_created_by, p_cashier_id), p_table_session_id,
    'completed', now(), now(), p_idempotency_key, v_snapshot
  ) RETURNING id INTO v_transaction_id;

  v_item_index := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
    v_quantity := COALESCE((v_item->>'quantity')::numeric, 0);
    v_packaging_id := NULLIF(v_item->>'packaging_id', '')::uuid;
    v_display_uom_id := NULLIF(v_item->>'display_uom_id', '')::uuid;
    v_display_quantity := NULLIF(v_item->>'display_quantity','')::numeric;

    INSERT INTO public.pos_transaction_items (
      transaction_id, product_id, description, quantity, unit_price, discount_type, discount_value,
      tax_rate, tax_amount, line_total, cost_price, sort_order, tax_rate_id, etims_tax_code,
      packaging_id, display_uom_id, display_quantity
    ) VALUES (
      v_transaction_id, v_product_id, v_item->>'name', v_quantity,
      (v_item->>'unit_price')::numeric, v_item->>'discount_type',
      COALESCE((v_item->>'discount_value')::numeric, 0),
      COALESCE((v_item->>'tax_rate')::numeric, 0),
      COALESCE((v_item->>'tax_amount')::numeric, 0),
      (v_item->>'line_total')::numeric, COALESCE((v_item->>'cost_price')::numeric, 0),
      v_item_index, NULLIF(v_item->>'tax_rate_id', '')::uuid, v_item->>'etims_tax_code',
      v_packaging_id, v_display_uom_id, v_display_quantity);

    IF v_product_id IS NOT NULL THEN
      SELECT track_inventory INTO v_track_inventory FROM public.products
      WHERE id = v_product_id AND organization_id = v_register_org_id
        AND business_id = v_register_business_id;
      IF v_track_inventory = true THEN
        IF v_default_warehouse_id IS NULL THEN
          RAISE EXCEPTION 'No active warehouse found for POS register branch % — create a branch warehouse before selling tracked inventory', v_register_branch_id
            USING ERRCODE = 'check_violation';
        END IF;
        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by, movement_date,
          source_packaging_id, source_uom_id
        ) VALUES (
          v_register_org_id, v_register_business_id, v_register_branch_id,
          v_product_id, v_default_warehouse_id,
          CASE WHEN p_transaction_type = 'return' THEN 'pos_return' ELSE 'pos_sale' END,
          CASE WHEN p_transaction_type = 'return' THEN v_quantity ELSE -v_quantity END,
          COALESCE((v_item->>'cost_price')::numeric, 0),
          'pos_transaction', v_transaction_id,
          CASE WHEN p_transaction_type = 'return' THEN 'POS Return: ' ELSE 'POS Sale: ' END || v_transaction_number,
          COALESCE(p_created_by, p_cashier_id), now(),
          v_packaging_id, v_display_uom_id);
      END IF;
    END IF;
    v_item_index := v_item_index + 1;
  END LOOP;

  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments) LOOP
    v_p_method := v_payment->>'payment_method';
    v_p_amount := COALESCE((v_payment->>'amount')::numeric, 0);
    v_p_tendered := COALESCE((v_payment->>'tendered_amount')::numeric, v_p_amount);
    v_p_change := COALESCE((v_payment->>'change_given')::numeric, GREATEST(0, v_p_tendered - v_p_amount));
    INSERT INTO public.pos_transaction_payments (
      transaction_id, payment_method, amount, tendered_amount, change_given, reference,
      card_last_four, card_type, mpesa_receipt_number, status, processed_at
    ) VALUES (
      v_transaction_id, v_p_method, v_p_amount, v_p_tendered, v_p_change,
      v_payment->>'reference', v_payment->>'card_last_four', v_payment->>'card_type',
      v_payment->>'mpesa_receipt_number', 'completed', now());
  END LOOP;

  UPDATE public.pos_shifts SET
    total_sales = total_sales + CASE WHEN p_transaction_type = 'sale' THEN p_total ELSE 0 END,
    total_returns = total_returns + CASE WHEN p_transaction_type = 'return' THEN p_total ELSE 0 END,
    total_transactions = total_transactions + 1,
    cash_payments = cash_payments + v_cash_total,
    card_payments = card_payments + (v_total_paid - v_cash_total),
    expected_cash = COALESCE(expected_cash, 0) + v_cash_total,
    updated_at = now()
  WHERE id = p_shift_id AND organization_id = v_register_org_id
    AND business_id = v_register_business_id AND branch_id = v_register_branch_id;

  DELETE FROM public.pos_stock_reservations WHERE register_id = p_register_id;

  IF p_table_session_id IS NOT NULL THEN
    UPDATE public.pos_table_sessions SET status = 'completed', closed_at = now(),
      total_amount = p_total, updated_at = now() WHERE id = p_table_session_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'idempotent_replay', false,
    'transaction_id', v_transaction_id, 'transaction_number', v_transaction_number,
    'change', v_total_change, 'tendered', v_total_tendered,
    'branch_id', v_register_branch_id, 'business_id', v_register_business_id);
END;
$function$;

-- ============== C2: businesses.cost_model setting ==============
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS cost_model text NOT NULL DEFAULT 'wac'
    CHECK (cost_model IN ('wac','fifo'));
COMMENT ON COLUMN public.businesses.cost_model IS
  'Inventory valuation method. wac (default) uses products.cost_price moving weighted-average. fifo uses cost_layers / v_cost_layer_basis. Switching mid-life requires a recosting RPC.';
