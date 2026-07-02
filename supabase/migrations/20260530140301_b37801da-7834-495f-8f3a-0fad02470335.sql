
-- ============================================================
-- Phase 2 + 3 + 4: Lot-aware outbound (delivery, POS sale, POS return)
-- ============================================================

-- ----- 1. Trigger: classify pos_return as inbound -----
CREATE OR REPLACE FUNCTION public._maintain_warehouse_stock_lots()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_qty_abs   numeric;
  v_is_in     boolean;
  v_is_out    boolean;
  v_lot_id    uuid;
  v_is_lot_tracked boolean;
  v_signed_delta numeric;
  v_mt text;
BEGIN
  IF NEW.product_id IS NULL OR NEW.warehouse_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_qty_abs := abs(COALESCE(NEW.quantity, 0));
  IF v_qty_abs = 0 THEN RETURN NEW; END IF;

  v_mt := NEW.movement_type::text;

  v_is_in  := v_mt IN
    ('receipt','adjustment_in','transfer_in','opening_stock',
     'return_in','customer_return','pos_return');
  v_is_out := v_mt IN
    ('sale','delivery','pos_sale','transfer_out','scrap',
     'adjustment_out','return_out','vendor_return');

  IF NOT (v_is_in OR v_is_out) AND v_mt IN ('adjustment','transfer') THEN
    IF NEW.quantity > 0 THEN v_is_in := true;
    ELSIF NEW.quantity < 0 THEN v_is_out := true;
    END IF;
  END IF;

  IF NOT (v_is_in OR v_is_out) THEN
    RETURN NEW;
  END IF;

  SELECT is_lot_tracked INTO v_is_lot_tracked FROM public.products WHERE id = NEW.product_id;

  IF NEW.lot_number IS NULL OR NEW.lot_number = '' THEN
    IF COALESCE(v_is_lot_tracked, false) AND v_is_out THEN
      RAISE EXCEPTION 'Product % is lot-tracked but outbound movement % has no lot_number',
        NEW.product_id, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT id INTO v_lot_id FROM public.stock_lots
   WHERE business_id = NEW.business_id AND product_id = NEW.product_id
     AND lot_number = NEW.lot_number
     AND ((serial_number IS NULL AND NEW.serial_number IS NULL) OR serial_number = NEW.serial_number)
   LIMIT 1;

  IF v_lot_id IS NULL THEN
    IF v_is_out THEN
      RAISE EXCEPTION 'Lot % does not exist for product % — cannot consume',
        NEW.lot_number, NEW.product_id USING ERRCODE = 'no_data_found';
    END IF;
    INSERT INTO public.stock_lots (organization_id, business_id, product_id, lot_number, serial_number)
    VALUES (NEW.organization_id, NEW.business_id, NEW.product_id, NEW.lot_number, NEW.serial_number)
    ON CONFLICT (business_id, product_id, lot_number, serial_number) DO NOTHING
    RETURNING id INTO v_lot_id;
    IF v_lot_id IS NULL THEN
      SELECT id INTO v_lot_id FROM public.stock_lots
       WHERE business_id = NEW.business_id AND product_id = NEW.product_id
         AND lot_number = NEW.lot_number
         AND ((serial_number IS NULL AND NEW.serial_number IS NULL) OR serial_number = NEW.serial_number);
    END IF;
  END IF;

  v_signed_delta := CASE WHEN v_is_in THEN v_qty_abs ELSE -v_qty_abs END;

  INSERT INTO public.warehouse_stock_lots (
    organization_id, business_id, warehouse_id, product_id, lot_id, quantity
  ) VALUES (
    NEW.organization_id, NEW.business_id, NEW.warehouse_id, NEW.product_id, v_lot_id, v_signed_delta
  )
  ON CONFLICT (business_id, warehouse_id, product_id, lot_id)
  DO UPDATE SET quantity = public.warehouse_stock_lots.quantity + v_signed_delta;

  RETURN NEW;
END;
$function$;

-- ----- 2. Schema additions for lot-aware lines -----
ALTER TABLE public.delivery_note_items
  ADD COLUMN IF NOT EXISTS lot_allocations jsonb,
  ADD COLUMN IF NOT EXISTS lot_number text,
  ADD COLUMN IF NOT EXISTS serial_number text;

ALTER TABLE public.pos_transaction_items
  ADD COLUMN IF NOT EXISTS lot_allocations jsonb,
  ADD COLUMN IF NOT EXISTS lot_number text,
  ADD COLUMN IF NOT EXISTS serial_number text;

-- ----- 3. Lot-aware complete_delivery_atomic -----
CREATE OR REPLACE FUNCTION public.complete_delivery_atomic(
  p_dn_id uuid, p_user_id uuid,
  p_received_by text DEFAULT NULL::text,
  p_pod jsonb DEFAULT NULL::jsonb,
  p_received_by_user_id uuid DEFAULT NULL::uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_dn record; v_so_branch_id uuid; v_warehouse_id uuid; v_branch_id uuid;
  v_org_id uuid; v_biz_id uuid; v_item record; v_unit_cost numeric;
  v_line_cost numeric; v_total_cogs numeric := 0;
  v_inventory_acct uuid; v_cogs_acct uuid; v_journal_id uuid; v_entry_no text;
  v_movement_count int := 0; v_so_id uuid; v_all_fulfilled boolean; v_any_fulfilled boolean;
  v_cogs_lines jsonb; v_currency text; v_pod_id uuid; v_is_partial boolean := false;
  v_pod_contact uuid; v_received_by_clean text; v_invoiced_qty numeric;
  v_sibling_delivered numeric; v_spawned jsonb;
  v_spawned_invoice_id uuid; v_spawned_invoice_number text;
  v_is_lot_tracked boolean; v_allocs jsonb; v_alloc_sum numeric;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;

  IF p_received_by IS NOT NULL AND p_received_by ~ '^[0-9a-fA-F-]{36}$' THEN
    RAISE EXCEPTION 'p_received_by must be a recipient name, not a user id (got %). Pass the staff user id via p_received_by_user_id.', p_received_by
      USING ERRCODE='22023';
  END IF;
  v_received_by_clean := NULLIF(btrim(COALESCE(p_received_by, '')), '');

  SELECT id, organization_id, business_id, branch_id, sales_order_id, source_invoice_id,
         delivery_number, status, auto_invoice_on_complete, spawned_invoice_id, contact_id
    INTO v_dn FROM public.delivery_notes WHERE id = p_dn_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Delivery note not found'); END IF;

  IF v_dn.status IN ('delivered','partial','cancelled') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery already finalised');
  END IF;

  v_org_id := v_dn.organization_id;
  v_biz_id := v_dn.business_id;
  v_so_id := v_dn.sales_order_id;

  IF v_biz_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_biz_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_biz_id USING ERRCODE='42501';
  END IF;

  IF v_dn.source_invoice_id IS NOT NULL THEN
    FOR v_item IN
      SELECT dni.product_id, SUM(dni.quantity_delivered) AS qty
        FROM public.delivery_note_items dni
       WHERE dni.delivery_note_id = p_dn_id AND dni.quantity_delivered > 0
         AND dni.product_id IS NOT NULL
       GROUP BY dni.product_id
    LOOP
      SELECT COALESCE(SUM(ii.quantity), 0) INTO v_invoiced_qty
        FROM public.invoice_items ii
       WHERE ii.invoice_id = v_dn.source_invoice_id AND ii.product_id = v_item.product_id;
      SELECT COALESCE(SUM(sdni.quantity_delivered), 0) INTO v_sibling_delivered
        FROM public.delivery_notes sdn
        JOIN public.delivery_note_items sdni ON sdni.delivery_note_id = sdn.id
       WHERE sdn.source_invoice_id = v_dn.source_invoice_id
         AND sdn.id <> p_dn_id AND sdn.status IN ('delivered','partial')
         AND sdni.product_id = v_item.product_id;
      IF v_invoiced_qty > 0 AND (v_sibling_delivered + v_item.qty) > v_invoiced_qty THEN
        RAISE EXCEPTION 'Over-delivery blocked: product % — invoiced %, already delivered %, attempting % more (would exceed invoice)',
          v_item.product_id, v_invoiced_qty, v_sibling_delivered, v_item.qty USING ERRCODE='22023';
      END IF;
    END LOOP;
  END IF;

  SELECT id, branch_id INTO v_warehouse_id, v_branch_id
    FROM public.warehouses
   WHERE organization_id = v_org_id AND business_id = v_biz_id
     AND COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(v_dn.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND is_active = true AND COALESCE(is_in_transit, false) = false
   ORDER BY is_default DESC NULLS LAST, created_at ASC LIMIT 1;

  IF v_warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No active warehouse found for this branch — create one before delivering.');
  END IF;

  IF v_so_id IS NOT NULL THEN
    SELECT branch_id INTO v_so_branch_id FROM public.sales_orders WHERE id = v_so_id;
    IF v_so_branch_id IS NOT NULL AND v_branch_id IS NOT NULL AND v_so_branch_id <> v_branch_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'Sales order is in a different branch than the warehouse.');
    END IF;
  END IF;

  FOR v_item IN
    SELECT dni.id, dni.product_id, dni.description, dni.quantity_ordered, dni.quantity_delivered,
           dni.sales_order_item_id, dni.lot_allocations, dni.lot_number, dni.serial_number,
           p.cost_price, p.track_inventory, COALESCE(p.is_lot_tracked,false) AS is_lot_tracked
      FROM public.delivery_note_items dni
 LEFT JOIN public.products p ON p.id = dni.product_id
     WHERE dni.delivery_note_id = p_dn_id AND dni.quantity_delivered > 0
  LOOP
    IF v_item.quantity_delivered < v_item.quantity_ordered THEN
      v_is_partial := true;
    END IF;
    IF v_item.sales_order_item_id IS NOT NULL THEN
      UPDATE public.sales_order_items
         SET quantity_fulfilled = COALESCE(quantity_fulfilled, 0) + v_item.quantity_delivered
       WHERE id = v_item.sales_order_item_id;
    END IF;

    IF v_so_id IS NOT NULL AND v_item.product_id IS NOT NULL
       AND COALESCE(v_item.track_inventory, true) THEN
      PERFORM public.consume_so_reservation(v_org_id, v_so_id, v_item.product_id, v_item.quantity_delivered);
    END IF;

    IF v_item.product_id IS NULL OR NOT COALESCE(v_item.track_inventory, true) THEN CONTINUE; END IF;

    v_unit_cost := COALESCE(v_item.cost_price, 0);
    v_is_lot_tracked := v_item.is_lot_tracked;

    IF v_is_lot_tracked THEN
      -- Honour caller allocations or auto-FEFO
      IF v_item.lot_allocations IS NOT NULL
         AND jsonb_typeof(v_item.lot_allocations) = 'array'
         AND jsonb_array_length(v_item.lot_allocations) > 0 THEN
        v_allocs := v_item.lot_allocations;
        SELECT COALESCE(SUM((e->>'qty')::numeric), 0) INTO v_alloc_sum
          FROM jsonb_array_elements(v_allocs) AS e;
        IF v_alloc_sum <> v_item.quantity_delivered THEN
          RAISE EXCEPTION 'lot_allocations sum (%) must equal quantity_delivered (%) for product %',
            v_alloc_sum, v_item.quantity_delivered, v_item.product_id
            USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                  'lot_number', r.lot_number,
                  'serial_number', r.serial_number,
                  'qty', r.qty)), '[]'::jsonb)
          INTO v_allocs
          FROM public.resolve_fefo_lots(v_biz_id, v_warehouse_id, v_item.product_id, v_item.quantity_delivered) r;
        IF v_allocs IS NULL OR jsonb_array_length(v_allocs) = 0 THEN
          RAISE EXCEPTION 'No lots available to satisfy delivery of % unit(s) of product %',
            v_item.quantity_delivered, v_item.product_id USING ERRCODE='no_data_found';
        END IF;
        UPDATE public.delivery_note_items SET lot_allocations = v_allocs WHERE id = v_item.id;
      END IF;

      PERFORM public.consume_lots_atomic(
        v_org_id, v_biz_id, v_warehouse_id, v_branch_id,
        v_item.product_id, 'delivery',
        'delivery_note', p_dn_id, p_user_id,
        'Delivery ' || v_dn.delivery_number || COALESCE(' — ' || v_item.description, ''),
        v_allocs, v_unit_cost
      );
      v_movement_count := v_movement_count + (SELECT jsonb_array_length(v_allocs));
    ELSE
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, warehouse_id,
        product_id, movement_type, quantity, unit_cost,
        reference_type, reference_id, notes, created_by
      ) VALUES (
        v_org_id, v_biz_id, v_branch_id, v_warehouse_id,
        v_item.product_id, 'delivery', -ABS(v_item.quantity_delivered), v_unit_cost,
        'delivery_note', p_dn_id,
        'Delivery ' || v_dn.delivery_number || COALESCE(' — ' || v_item.description, ''),
        p_user_id
      );
      v_movement_count := v_movement_count + 1;
    END IF;

    v_line_cost := ABS(v_item.quantity_delivered) * v_unit_cost;
    v_total_cogs := v_total_cogs + v_line_cost;
  END LOOP;

  IF v_total_cogs > 0 THEN
    SELECT COALESCE(base_currency, 'USD') INTO v_currency FROM public.businesses WHERE id = v_biz_id;
    SELECT id INTO v_inventory_acct FROM public.accounts
     WHERE organization_id = v_org_id AND business_id = v_biz_id
       AND detail_type = 'inventory' AND is_active = true LIMIT 1;
    SELECT id INTO v_cogs_acct FROM public.accounts
     WHERE organization_id = v_org_id AND business_id = v_biz_id
       AND detail_type = 'cost_of_goods_sold' AND is_active = true LIMIT 1;

    IF v_inventory_acct IS NOT NULL AND v_cogs_acct IS NOT NULL THEN
      SELECT public.get_next_journal_entry_number(v_org_id) INTO v_entry_no;
      v_cogs_lines := jsonb_build_array(
        jsonb_build_object('account_id', v_cogs_acct, 'debit', v_total_cogs, 'credit', 0, 'description', 'COGS - ' || v_dn.delivery_number),
        jsonb_build_object('account_id', v_inventory_acct, 'debit', 0, 'credit', v_total_cogs, 'description', 'Inventory reduction - ' || v_dn.delivery_number)
      );
      v_journal_id := public.post_journal_entry_atomic(
        _org_id := v_org_id, _business_id := v_biz_id,
        _entry_number := v_entry_no, _entry_date := CURRENT_DATE,
        _reference := 'COGS-' || v_dn.delivery_number,
        _description := 'COGS for delivery ' || v_dn.delivery_number,
        _source_type := 'delivery_note', _source_id := p_dn_id,
        _created_by := p_user_id, _is_closing := false, _is_adjusting := false,
        _lines := v_cogs_lines, _currency := v_currency, _exchange_rate := NULL,
        _source_subtype := 'cogs', _branch_id := v_branch_id
      );
    END IF;
  END IF;

  v_pod_contact := NULLIF(p_pod->>'received_by_contact_id','')::uuid;

  UPDATE public.delivery_notes
     SET status = CASE WHEN v_is_partial THEN 'partial' ELSE 'delivered' END,
         delivered_at = now(),
         received_by = COALESCE(v_received_by_clean, received_by),
         received_by_contact_id = COALESCE(v_pod_contact, received_by_contact_id),
         received_by_user_id = COALESCE(p_received_by_user_id, received_by_user_id),
         updated_at = now()
   WHERE id = p_dn_id;

  IF p_pod IS NOT NULL AND p_pod <> '{}'::jsonb THEN
    INSERT INTO public.delivery_proofs (
      delivery_note_id, organization_id, business_id,
      signature_url, photo_urls, received_by_contact_id, received_by_name,
      received_at, gps_lat, gps_lng, notes, created_by
    ) VALUES (
      p_dn_id, v_org_id, v_biz_id,
      p_pod->>'signature_url',
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_pod->'photo_urls')), ARRAY[]::text[]),
      v_pod_contact,
      COALESCE(p_pod->>'received_by_name', v_received_by_clean),
      COALESCE(NULLIF(p_pod->>'received_at','')::timestamptz, now()),
      NULLIF(p_pod->>'gps_lat','')::numeric,
      NULLIF(p_pod->>'gps_lng','')::numeric,
      p_pod->>'notes', p_user_id
    ) RETURNING id INTO v_pod_id;
  END IF;

  IF v_so_id IS NOT NULL THEN
    SELECT bool_and(quantity_fulfilled >= quantity), bool_or(quantity_fulfilled > 0)
      INTO v_all_fulfilled, v_any_fulfilled
      FROM public.sales_order_items WHERE sales_order_id = v_so_id;
    IF v_all_fulfilled THEN
      UPDATE public.sales_orders SET status = 'fulfilled', updated_at = now()
       WHERE id = v_so_id AND status NOT IN ('invoiced','cancelled');
    ELSIF v_any_fulfilled THEN
      UPDATE public.sales_orders SET status = 'partial', updated_at = now()
       WHERE id = v_so_id AND status NOT IN ('invoiced','cancelled','fulfilled');
    END IF;
  END IF;

  IF COALESCE(v_dn.auto_invoice_on_complete, true)
     AND v_dn.source_invoice_id IS NULL AND v_dn.spawned_invoice_id IS NULL
     AND v_dn.contact_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.delivery_note_items
                  WHERE delivery_note_id = p_dn_id AND quantity_delivered > 0 AND unit_price IS NOT NULL)
  THEN
    v_spawned := public.create_invoice_from_delivery_atomic(p_dn_id, p_user_id);
    v_spawned_invoice_id := (v_spawned->>'invoice_id')::uuid;
    v_spawned_invoice_number := v_spawned->>'invoice_number';
  END IF;

  PERFORM public._log_dn_event(p_dn_id, CASE WHEN v_is_partial THEN 'partially_delivered' ELSE 'delivered' END,
    p_user_id, v_received_by_clean,
    jsonb_build_object('movements', v_movement_count, 'cogs', v_total_cogs, 'pod_id', v_pod_id,
                       'spawned_invoice_id', v_spawned_invoice_id,
                       'spawned_invoice_number', v_spawned_invoice_number));

  RETURN jsonb_build_object(
    'success', true, 'delivery_id', p_dn_id, 'warehouse_id', v_warehouse_id,
    'movements_created', v_movement_count, 'gl_posted', v_journal_id IS NOT NULL,
    'cogs_total', v_total_cogs, 'pod_id', v_pod_id, 'partial', v_is_partial,
    'spawned_invoice_id', v_spawned_invoice_id,
    'spawned_invoice_number', v_spawned_invoice_number
  );
END $function$;

-- ----- 4. Lot-aware process_pos_transaction (sale branch only) -----
CREATE OR REPLACE FUNCTION public.process_pos_transaction(
  p_organization_id uuid, p_business_id uuid, p_register_id uuid, p_shift_id uuid,
  p_items jsonb, p_payments jsonb,
  p_subtotal numeric, p_tax_amount numeric, p_discount_amount numeric, p_total numeric,
  p_transaction_type text DEFAULT 'sale'::text,
  p_customer_id uuid DEFAULT NULL::uuid, p_customer_tin text DEFAULT NULL::text,
  p_customer_name text DEFAULT NULL::text, p_notes text DEFAULT NULL::text,
  p_cashier_id uuid DEFAULT NULL::uuid, p_created_by uuid DEFAULT NULL::uuid,
  p_original_transaction_id uuid DEFAULT NULL::uuid, p_tip_amount numeric DEFAULT 0,
  p_table_session_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
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
  v_is_lot_tracked boolean; v_item_allocs jsonb; v_alloc_sum numeric;
  v_item_unit_cost numeric; v_new_item_id uuid;
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
    v_item_unit_cost := COALESCE((v_item->>'cost_price')::numeric, 0);

    v_is_lot_tracked := false;
    IF v_product_id IS NOT NULL THEN
      SELECT COALESCE(is_lot_tracked,false), track_inventory
        INTO v_is_lot_tracked, v_track_inventory
        FROM public.products WHERE id = v_product_id
          AND organization_id = v_register_org_id AND business_id = v_register_business_id;
    END IF;

    -- Determine lot allocations for sale on lot-tracked product
    v_item_allocs := NULL;
    IF p_transaction_type = 'sale' AND v_is_lot_tracked AND COALESCE(v_track_inventory,false)
       AND v_quantity > 0 AND v_default_warehouse_id IS NOT NULL THEN
      IF (v_item ? 'lot_allocations')
         AND jsonb_typeof(v_item->'lot_allocations') = 'array'
         AND jsonb_array_length(v_item->'lot_allocations') > 0 THEN
        v_item_allocs := v_item->'lot_allocations';
        SELECT COALESCE(SUM((e->>'qty')::numeric), 0) INTO v_alloc_sum
          FROM jsonb_array_elements(v_item_allocs) AS e;
        IF v_alloc_sum <> v_quantity THEN
          RAISE EXCEPTION 'POS lot_allocations sum (%) must equal quantity (%) for product %',
            v_alloc_sum, v_quantity, v_product_id USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                  'lot_number', r.lot_number,
                  'serial_number', r.serial_number,
                  'qty', r.qty)), '[]'::jsonb)
          INTO v_item_allocs
          FROM public.resolve_fefo_lots(v_register_business_id, v_default_warehouse_id, v_product_id, v_quantity) r;
        IF v_item_allocs IS NULL OR jsonb_array_length(v_item_allocs) = 0 THEN
          RAISE EXCEPTION 'No lots available to fulfil sale of % unit(s) of product %',
            v_quantity, v_product_id USING ERRCODE='no_data_found';
        END IF;
      END IF;
    END IF;

    INSERT INTO public.pos_transaction_items (
      transaction_id, product_id, description, quantity, unit_price, discount_type, discount_value,
      tax_rate, tax_amount, line_total, cost_price, sort_order, tax_rate_id, etims_tax_code,
      packaging_id, display_uom_id, display_quantity, lot_allocations
    ) VALUES (
      v_transaction_id, v_product_id, v_item->>'name', v_quantity,
      (v_item->>'unit_price')::numeric, v_item->>'discount_type',
      COALESCE((v_item->>'discount_value')::numeric, 0),
      COALESCE((v_item->>'tax_rate')::numeric, 0),
      COALESCE((v_item->>'tax_amount')::numeric, 0),
      (v_item->>'line_total')::numeric, v_item_unit_cost,
      v_item_index, NULLIF(v_item->>'tax_rate_id', '')::uuid, v_item->>'etims_tax_code',
      v_packaging_id, v_display_uom_id, v_display_quantity, v_item_allocs
    ) RETURNING id INTO v_new_item_id;

    IF v_product_id IS NOT NULL AND COALESCE(v_track_inventory,false) THEN
      IF v_default_warehouse_id IS NULL THEN
        RAISE EXCEPTION 'No active warehouse found for POS register branch % — create a branch warehouse before selling tracked inventory', v_register_branch_id
          USING ERRCODE = 'check_violation';
      END IF;

      IF p_transaction_type = 'sale' AND v_is_lot_tracked THEN
        PERFORM public.consume_lots_atomic(
          v_register_org_id, v_register_business_id, v_default_warehouse_id, v_register_branch_id,
          v_product_id, 'pos_sale', 'pos_transaction', v_transaction_id,
          COALESCE(p_created_by, p_cashier_id),
          'POS Sale: ' || v_transaction_number,
          v_item_allocs, v_item_unit_cost
        );
      ELSE
        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by, movement_date,
          source_packaging_id, source_uom_id
        ) VALUES (
          v_register_org_id, v_register_business_id, v_register_branch_id,
          v_product_id, v_default_warehouse_id,
          CASE WHEN p_transaction_type = 'return' THEN 'pos_return' ELSE 'pos_sale' END,
          CASE WHEN p_transaction_type = 'return' THEN v_quantity ELSE -v_quantity END,
          v_item_unit_cost,
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
END $function$;

-- ----- 5. Lot-aware process_pos_return -----
CREATE OR REPLACE FUNCTION public.process_pos_return(
  p_organization_id uuid, p_register_id uuid, p_shift_id uuid,
  p_original_transaction_id uuid, p_items jsonb,
  p_refund_method text DEFAULT 'cash'::text, p_notes text DEFAULT NULL::text,
  p_created_by uuid DEFAULT NULL::uuid, p_override_id uuid DEFAULT NULL::uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_transaction_id UUID; v_transaction_number TEXT; v_register_code TEXT;
  v_register_branch_id UUID; v_register_business_id UUID; v_register_org_id UUID;
  v_shift_warehouse_id UUID; v_default_warehouse_id UUID; v_item JSONB;
  v_product_id UUID; v_quantity NUMERIC; v_track_inventory BOOLEAN;
  v_subtotal NUMERIC := 0; v_tax_amount NUMERIC := 0; v_total NUMERIC := 0;
  v_item_index INT := 0; v_original_status TEXT; v_original_business_id UUID;
  v_original_item_id UUID; v_returnable NUMERIC; v_item_total NUMERIC; v_item_tax NUMERIC;
  v_reason_id UUID; v_reason_code TEXT; v_reason_requires_note BOOLEAN;
  v_reason_requires_override BOOLEAN; v_reason_note TEXT;
  v_unit_price NUMERIC; v_tax_rate NUMERIC; v_cost_price NUMERIC; v_description TEXT;
  v_refund_tender TEXT; v_is_cross_tender BOOLEAN := false;
  v_any_reason_needs_override BOOLEAN := false; v_override_reason_codes TEXT := '';
  v_is_lot_tracked boolean; v_orig_allocs jsonb; v_return_allocs jsonb;
  v_orig_qty numeric; v_remaining numeric; v_take numeric; v_elem jsonb;
BEGIN
  SELECT register_code, branch_id, business_id, organization_id
    INTO v_register_code, v_register_branch_id, v_register_business_id, v_register_org_id
  FROM public.pos_registers WHERE id = p_register_id;
  IF v_register_code IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_register', 'details', 'Register not found');
  END IF;
  IF v_register_org_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'Register % belongs to a different organization than supplied', p_register_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_register_branch_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_register', 'details', 'Register has no branch context');
  END IF;
  PERFORM public.assert_pos_caller_branch_access(v_register_branch_id);

  SELECT status, business_id INTO v_original_status, v_original_business_id
  FROM public.pos_transactions
  WHERE id = p_original_transaction_id AND organization_id = p_organization_id;
  IF v_original_status IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'original_not_found', 'details', 'Original transaction not found');
  END IF;
  IF v_original_status = 'voided' THEN
    RETURN jsonb_build_object('success', false, 'error', 'original_voided', 'details', 'Cannot return a voided transaction');
  END IF;
  IF v_original_status != 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status',
      'details', 'Original transaction is not completed (status: ' || v_original_status || ')');
  END IF;
  IF v_original_business_id IS DISTINCT FROM v_register_business_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'cross_company_return',
      'details', 'Original transaction belongs to a different company than this register');
  END IF;

  v_refund_tender := CASE WHEN p_refund_method = 'store_credit' THEN 'voucher' ELSE p_refund_method END;
  SELECT NOT EXISTS (SELECT 1 FROM public.pos_transaction_payments
     WHERE transaction_id = p_original_transaction_id AND payment_method = v_refund_tender
       AND COALESCE(status, 'completed') = 'completed') INTO v_is_cross_tender;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_original_item_id := (v_item->>'original_item_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;
    IF v_original_item_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'missing_original_item',
        'details', 'Each return line must reference an original_item_id');
    END IF;
    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_quantity',
        'details', 'Return quantity must be greater than zero');
    END IF;
    SELECT returnable_qty INTO v_returnable FROM public.v_pos_returnable_qty
    WHERE original_item_id = v_original_item_id AND original_transaction_id = p_original_transaction_id;
    IF v_returnable IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'item_not_found',
        'details', 'Original item not found on this transaction');
    END IF;
    IF v_quantity > v_returnable THEN
      RETURN jsonb_build_object('success', false, 'error', 'over_return',
        'details', format('Cannot return %s — only %s remaining for this line', v_quantity, v_returnable));
    END IF;
    v_reason_id := NULLIF(v_item->>'return_reason_id','')::UUID;
    IF v_reason_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'missing_reason',
        'details', 'A return reason is required for every line');
    END IF;
    SELECT code, requires_note, requires_manager_override
      INTO v_reason_code, v_reason_requires_note, v_reason_requires_override
    FROM public.pos_return_reasons WHERE id = v_reason_id AND is_active = true;
    IF v_reason_code IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_reason',
        'details', 'Selected return reason is not valid');
    END IF;
    v_reason_note := NULLIF(trim(coalesce(v_item->>'return_reason_note','')), '');
    IF v_reason_requires_note AND v_reason_note IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'reason_note_required',
        'details', format('Reason "%s" requires an explanatory note', v_reason_code));
    END IF;
    IF NOT v_reason_requires_note AND v_reason_note IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'reason_note_not_allowed',
        'details', 'Free-text note only allowed for reasons that require a note');
    END IF;
    IF COALESCE(v_reason_requires_override, false) THEN
      v_any_reason_needs_override := true;
      IF position(v_reason_code IN v_override_reason_codes) = 0 THEN
        v_override_reason_codes := v_override_reason_codes ||
          CASE WHEN v_override_reason_codes = '' THEN '' ELSE ',' END || v_reason_code;
      END IF;
    END IF;
    SELECT unit_price, tax_rate INTO v_unit_price, v_tax_rate
    FROM public.v_pos_returnable_qty WHERE original_item_id = v_original_item_id;
    v_item_total := v_unit_price * v_quantity;
    v_item_tax := v_item_total * COALESCE(v_tax_rate, 0) / 100;
    v_subtotal := v_subtotal + v_item_total;
    v_tax_amount := v_tax_amount + v_item_tax;
  END LOOP;
  v_total := v_subtotal + v_tax_amount;

  IF v_any_reason_needs_override AND p_override_id IS NULL THEN
    RAISE EXCEPTION 'override_required' USING ERRCODE = 'check_violation',
      HINT = format('Reason(s) %s require manager approval', v_override_reason_codes),
      DETAIL = 'reason_requires_override';
  END IF;

  IF v_is_cross_tender THEN
    PERFORM public.assert_manager_override('cross_tender_refund', v_total, p_organization_id,
      v_register_business_id, p_shift_id, p_override_id, 'pos_transactions', NULL);
  ELSE
    PERFORM public.assert_manager_override('refund', v_total, p_organization_id,
      v_register_business_id, p_shift_id, p_override_id, 'pos_transactions', NULL);
  END IF;

  SELECT warehouse_id INTO v_shift_warehouse_id FROM public.pos_shifts
  WHERE id = p_shift_id AND organization_id = v_register_org_id
    AND business_id = v_register_business_id AND register_id = p_register_id;
  v_default_warehouse_id := v_shift_warehouse_id;
  IF v_default_warehouse_id IS NULL THEN
    SELECT id INTO v_default_warehouse_id FROM public.warehouses
     WHERE organization_id = v_register_org_id AND business_id = v_register_business_id
       AND branch_id = v_register_branch_id AND is_active = true
     ORDER BY is_default DESC, created_at ASC LIMIT 1;
  END IF;
  v_transaction_number := public.get_next_pos_transaction_number(p_organization_id, v_register_code);

  INSERT INTO public.pos_transactions (
    id, organization_id, business_id, branch_id, register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id, subtotal, tax_amount, discount_amount, total,
    payment_status, status, completed_at, created_by, notes, created_at
  ) VALUES (
    gen_random_uuid(), p_organization_id, v_register_business_id, v_register_branch_id,
    p_register_id, p_shift_id, v_transaction_number, 'return', p_original_transaction_id,
    v_subtotal, v_tax_amount, 0, v_total, 'refunded', 'completed', now(), p_created_by,
    COALESCE(p_notes, '') || ' Return for txn ' || p_original_transaction_id::TEXT, now()
  ) RETURNING id INTO v_transaction_id;

  IF p_override_id IS NOT NULL THEN
    UPDATE public.pos_manager_overrides SET consumed_ref_id = v_transaction_id,
      transaction_id = v_transaction_id, amount = v_total,
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'original_transaction_id', p_original_transaction_id,
        'refund_tender', v_refund_tender, 'is_cross_tender', v_is_cross_tender,
        'reason_required_override', v_any_reason_needs_override,
        'override_reason_codes', v_override_reason_codes)
     WHERE id = p_override_id;
  END IF;

  v_item_index := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_original_item_id := (v_item->>'original_item_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;
    v_reason_id := (v_item->>'return_reason_id')::UUID;
    v_reason_note := NULLIF(trim(coalesce(v_item->>'return_reason_note','')), '');
    SELECT product_id, unit_price, tax_rate, cost_price, description
      INTO v_product_id, v_unit_price, v_tax_rate, v_cost_price, v_description
    FROM public.v_pos_returnable_qty WHERE original_item_id = v_original_item_id;
    v_item_total := v_unit_price * v_quantity;
    v_item_tax := v_item_total * COALESCE(v_tax_rate, 0) / 100;

    -- Decide lot allocations for the return: replay from original item's
    -- lot_allocations, proportionally taking the first quantity to match v_quantity.
    v_is_lot_tracked := false;
    v_return_allocs := NULL;
    IF v_product_id IS NOT NULL THEN
      SELECT COALESCE(is_lot_tracked,false) INTO v_is_lot_tracked
        FROM public.products WHERE id = v_product_id;
    END IF;

    IF v_is_lot_tracked THEN
      SELECT lot_allocations, quantity INTO v_orig_allocs, v_orig_qty
        FROM public.pos_transaction_items WHERE id = v_original_item_id;
      IF v_orig_allocs IS NOT NULL
         AND jsonb_typeof(v_orig_allocs) = 'array'
         AND jsonb_array_length(v_orig_allocs) > 0 THEN
        v_remaining := v_quantity;
        v_return_allocs := '[]'::jsonb;
        FOR v_elem IN SELECT * FROM jsonb_array_elements(v_orig_allocs) LOOP
          EXIT WHEN v_remaining <= 0;
          v_take := LEAST(v_remaining, COALESCE((v_elem->>'qty')::numeric, 0));
          IF v_take > 0 THEN
            v_return_allocs := v_return_allocs || jsonb_build_array(jsonb_build_object(
              'lot_number',  v_elem->>'lot_number',
              'serial_number', v_elem->>'serial_number',
              'qty', v_take));
            v_remaining := v_remaining - v_take;
          END IF;
        END LOOP;
        IF v_remaining > 0 THEN
          RAISE EXCEPTION 'Original lot allocations cannot cover return qty % for product %', v_quantity, v_product_id
            USING ERRCODE='check_violation';
        END IF;
      END IF;
    END IF;

    INSERT INTO public.pos_transaction_items (
      transaction_id, product_id, description, quantity, unit_price, discount_type, discount_value,
      tax_rate, tax_amount, line_total, cost_price, sort_order,
      original_item_id, return_reason_id, return_reason_note, lot_allocations
    ) VALUES (
      v_transaction_id, v_product_id, v_description, v_quantity, v_unit_price, NULL, 0,
      COALESCE(v_tax_rate, 0), v_item_tax, v_item_total + v_item_tax,
      v_cost_price, v_item_index, v_original_item_id, v_reason_id, v_reason_note, v_return_allocs);

    IF v_product_id IS NOT NULL THEN
      SELECT track_inventory INTO v_track_inventory FROM public.products
      WHERE id = v_product_id AND organization_id = p_organization_id AND business_id = v_register_business_id;
      IF v_track_inventory = true THEN
        IF v_default_warehouse_id IS NULL THEN
          RAISE EXCEPTION 'No active warehouse for POS register branch %; create one before processing returns', v_register_branch_id
            USING ERRCODE = 'check_violation';
        END IF;

        IF v_is_lot_tracked AND v_return_allocs IS NOT NULL
           AND jsonb_array_length(v_return_allocs) > 0 THEN
          -- Inbound; consume_lots_atomic writes a negative qty for outbound tokens only,
          -- so emit per-allocation stock_movements with positive qty for 'pos_return'.
          FOR v_elem IN SELECT * FROM jsonb_array_elements(v_return_allocs) LOOP
            INSERT INTO public.stock_movements (
              organization_id, business_id, branch_id, product_id, warehouse_id,
              movement_type, quantity, unit_cost, reference_type, reference_id,
              notes, created_by, movement_date, lot_number, serial_number
            ) VALUES (
              p_organization_id, v_register_business_id, v_register_branch_id,
              v_product_id, v_default_warehouse_id, 'pos_return',
              (v_elem->>'qty')::numeric, COALESCE(v_cost_price, 0),
              'pos_transaction', v_transaction_id,
              'POS Return: ' || v_transaction_number, p_created_by, now(),
              v_elem->>'lot_number', v_elem->>'serial_number'
            );
          END LOOP;
        ELSE
          INSERT INTO public.stock_movements (
            organization_id, business_id, branch_id, product_id, warehouse_id,
            movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by, movement_date
          ) VALUES (
            p_organization_id, v_register_business_id, v_register_branch_id,
            v_product_id, v_default_warehouse_id, 'pos_return', v_quantity, COALESCE(v_cost_price, 0),
            'pos_transaction', v_transaction_id, 'POS Return: ' || v_transaction_number, p_created_by, now());
        END IF;
      END IF;
    END IF;
    v_item_index := v_item_index + 1;
  END LOOP;

  INSERT INTO public.pos_transaction_payments (
    transaction_id, payment_method, amount, reference, status,
    organization_id, business_id, branch_id
  ) VALUES (
    v_transaction_id, v_refund_tender, -v_total, 'Refund - ' || v_transaction_number, 'completed',
    p_organization_id, v_register_business_id, v_register_branch_id);

  IF p_refund_method = 'cash' THEN
    UPDATE public.pos_shifts SET expected_cash = COALESCE(expected_cash, 0) - v_total,
      total_returns = COALESCE(total_returns, 0) + v_total, updated_at = now() WHERE id = p_shift_id;
  ELSE
    UPDATE public.pos_shifts SET total_returns = COALESCE(total_returns, 0) + v_total,
      updated_at = now() WHERE id = p_shift_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'transaction_id', v_transaction_id,
    'transaction_number', v_transaction_number, 'refund_amount', v_total,
    'business_id', v_register_business_id, 'branch_id', v_register_branch_id,
    'cross_tender', v_is_cross_tender, 'reason_required_override', v_any_reason_needs_override);
END;
$function$;
