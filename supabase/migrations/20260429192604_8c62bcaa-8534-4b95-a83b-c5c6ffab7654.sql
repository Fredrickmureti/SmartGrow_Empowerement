-- Sales → Inventory integrity hardening
-- 1) Fix complete_delivery_atomic to use canonical journal posting, not direct stale journal_entries columns.
-- 2) Add confirm_invoice_and_release_stock_atomic for one-action direct-invoice stock release.
-- 3) Add warehouse_stock-based inventory alert checks and trigger.

CREATE OR REPLACE FUNCTION public.check_warehouse_stock_alerts(p_warehouse_stock_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ws record;
  v_product record;
  v_settings record;
  v_alert_type text;
  v_title text;
  v_message text;
  v_priority int;
  v_threshold numeric;
  v_user record;
BEGIN
  SELECT ws.id, ws.organization_id, ws.business_id, ws.branch_id, ws.warehouse_id,
         ws.product_id, COALESCE(ws.quantity, 0) AS quantity,
         COALESCE(ws.reorder_level, 0) AS ws_reorder_level,
         w.name AS warehouse_name
    INTO v_ws
    FROM public.warehouse_stock ws
    LEFT JOIN public.warehouses w ON w.id = ws.warehouse_id
   WHERE ws.id = p_warehouse_stock_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT id, name, sku, track_inventory, is_active, reorder_level
    INTO v_product
    FROM public.products
   WHERE id = v_ws.product_id;

  IF NOT FOUND OR COALESCE(v_product.track_inventory, true) = false OR COALESCE(v_product.is_active, true) = false THEN
    RETURN;
  END IF;

  SELECT * INTO v_settings
    FROM public.notification_alert_settings nas
   WHERE nas.organization_id = v_ws.organization_id
     AND (nas.business_id = v_ws.business_id OR nas.business_id IS NULL)
   ORDER BY nas.business_id NULLS LAST
   LIMIT 1;

  IF v_ws.quantity <= 0 AND COALESCE(v_settings.out_of_stock_alert, true) THEN
    v_alert_type := 'out_of_stock';
    v_title := 'Out of Stock!';
    v_priority := 2;
    v_message := 'Product "' || COALESCE(v_product.name, 'Unknown product') || '" (' || COALESCE(v_product.sku, 'No SKU') || ') is now OUT OF STOCK in ' || COALESCE(v_ws.warehouse_name, 'the selected warehouse');
  ELSE
    v_threshold := GREATEST(
      COALESCE(NULLIF(v_ws.ws_reorder_level, 0), 0),
      COALESCE(NULLIF(v_product.reorder_level, 0), 0),
      COALESCE(v_settings.low_stock_warning_threshold, 10)
    );

    IF v_threshold > 0 AND v_ws.quantity <= v_threshold THEN
      v_alert_type := 'low_stock';
      v_title := 'Low Stock Alert';
      v_priority := 1;
      v_message := 'Product "' || COALESCE(v_product.name, 'Unknown product') || '" (' || COALESCE(v_product.sku, 'No SKU') || ') is below reorder level in ' || COALESCE(v_ws.warehouse_name, 'the selected warehouse') || '. Current: ' || v_ws.quantity || ', Reorder at: ' || v_threshold;
    ELSE
      RETURN;
    END IF;
  END IF;

  FOR v_user IN
    SELECT DISTINCT ur.user_id
      FROM public.user_roles ur
     WHERE ur.organization_id = v_ws.organization_id
       AND COALESCE(ur.is_active, true) = true
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM public.notifications n
       WHERE n.organization_id = v_ws.organization_id
         AND n.business_id IS NOT DISTINCT FROM v_ws.business_id
         AND n.user_id = v_user.user_id
         AND n.entity_type = v_alert_type
         AND n.entity_id = v_ws.product_id
         AND n.created_at > now() - interval '24 hours'
    ) THEN
      PERFORM public.create_notification(
        v_ws.organization_id,
        v_user.user_id,
        CASE WHEN v_alert_type = 'out_of_stock' THEN 'error' ELSE 'warning' END,
        'inventory',
        v_title,
        v_message,
        '/inventory',
        v_alert_type,
        v_ws.product_id,
        v_priority,
        v_ws.business_id
      );
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_check_warehouse_stock_alerts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR COALESCE(NEW.quantity, 0) IS DISTINCT FROM COALESCE(OLD.quantity, 0) THEN
    PERFORM public.check_warehouse_stock_alerts(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_warehouse_stock_alerts ON public.warehouse_stock;
CREATE TRIGGER trg_warehouse_stock_alerts
  AFTER INSERT OR UPDATE OF quantity ON public.warehouse_stock
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_check_warehouse_stock_alerts();

CREATE OR REPLACE FUNCTION public.complete_delivery_atomic(
  p_dn_id uuid,
  p_user_id uuid,
  p_received_by text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_dn record;
  v_so_branch_id uuid;
  v_warehouse_id uuid;
  v_branch_id uuid;
  v_org_id uuid;
  v_biz_id uuid;
  v_item record;
  v_unit_cost numeric;
  v_line_cost numeric;
  v_total_cogs numeric := 0;
  v_inventory_acct uuid;
  v_cogs_acct uuid;
  v_journal_id uuid;
  v_entry_no text;
  v_movement_count int := 0;
  v_so_id uuid;
  v_all_fulfilled boolean;
  v_any_fulfilled boolean;
  v_cogs_lines jsonb;
  v_currency text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT id, organization_id, business_id, branch_id, sales_order_id,
         delivery_number, status
    INTO v_dn
    FROM public.delivery_notes
   WHERE id = p_dn_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery note not found');
  END IF;

  IF v_dn.status = 'delivered' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery already marked');
  END IF;

  v_org_id := v_dn.organization_id;
  v_biz_id := v_dn.business_id;
  v_so_id := v_dn.sales_order_id;

  IF v_biz_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_biz_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_biz_id USING ERRCODE = '42501';
  END IF;

  SELECT id, branch_id INTO v_warehouse_id, v_branch_id
    FROM public.warehouses
   WHERE organization_id = v_org_id
     AND business_id = v_biz_id
     AND COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(v_dn.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND is_active = true
     AND COALESCE(is_in_transit, false) = false
   ORDER BY is_default DESC NULLS LAST, created_at ASC
   LIMIT 1;

  IF v_warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No active warehouse found for this branch — create one before delivering.');
  END IF;

  IF v_so_id IS NOT NULL THEN
    SELECT branch_id INTO v_so_branch_id FROM public.sales_orders WHERE id = v_so_id;
    IF v_so_branch_id IS NOT NULL AND v_branch_id IS NOT NULL AND v_so_branch_id <> v_branch_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'Sales order is in a different branch than the warehouse — pick a warehouse in the SO branch or transfer the order.');
    END IF;
  END IF;

  FOR v_item IN
    SELECT dni.id, dni.product_id, dni.description, dni.quantity_delivered,
           dni.sales_order_item_id,
           p.cost_price, p.track_inventory,
           p.inventory_account_id, p.cogs_account_id
      FROM public.delivery_note_items dni
 LEFT JOIN public.products p ON p.id = dni.product_id
     WHERE dni.delivery_note_id = p_dn_id
       AND dni.quantity_delivered > 0
  LOOP
    IF v_item.sales_order_item_id IS NOT NULL THEN
      UPDATE public.sales_order_items
         SET quantity_fulfilled = COALESCE(quantity_fulfilled, 0) + v_item.quantity_delivered
       WHERE id = v_item.sales_order_item_id;
    END IF;

    IF v_item.product_id IS NULL OR NOT COALESCE(v_item.track_inventory, true) THEN
      CONTINUE;
    END IF;

    v_unit_cost := COALESCE(v_item.cost_price, 0);

    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, movement_type, quantity, unit_cost,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_org_id, v_biz_id, v_branch_id, v_warehouse_id,
      v_item.product_id, 'delivery',
      -ABS(v_item.quantity_delivered),
      v_unit_cost,
      'delivery_note', p_dn_id,
      'Delivery ' || v_dn.delivery_number || COALESCE(' — ' || v_item.description, ''),
      p_user_id
    );

    v_movement_count := v_movement_count + 1;
    v_line_cost := ABS(v_item.quantity_delivered) * v_unit_cost;
    v_total_cogs := v_total_cogs + v_line_cost;
  END LOOP;

  IF v_total_cogs > 0 THEN
    SELECT COALESCE(base_currency, 'USD') INTO v_currency
      FROM public.businesses
     WHERE id = v_biz_id;

    SELECT id INTO v_inventory_acct
      FROM public.accounts
     WHERE organization_id = v_org_id
       AND business_id = v_biz_id
       AND detail_type = 'inventory'
       AND is_active = true
     LIMIT 1;

    SELECT id INTO v_cogs_acct
      FROM public.accounts
     WHERE organization_id = v_org_id
       AND business_id = v_biz_id
       AND detail_type = 'cost_of_goods_sold'
       AND is_active = true
     LIMIT 1;

    IF v_inventory_acct IS NOT NULL AND v_cogs_acct IS NOT NULL THEN
      SELECT public.get_next_journal_entry_number(v_org_id) INTO v_entry_no;
      v_cogs_lines := jsonb_build_array(
        jsonb_build_object('account_id', v_cogs_acct, 'debit', v_total_cogs, 'credit', 0, 'description', 'COGS - ' || v_dn.delivery_number),
        jsonb_build_object('account_id', v_inventory_acct, 'debit', 0, 'credit', v_total_cogs, 'description', 'Inventory reduction - ' || v_dn.delivery_number)
      );

      v_journal_id := public.post_journal_entry_atomic(
        _org_id := v_org_id,
        _business_id := v_biz_id,
        _entry_number := v_entry_no,
        _entry_date := CURRENT_DATE,
        _reference := 'COGS-' || v_dn.delivery_number,
        _description := 'COGS for delivery ' || v_dn.delivery_number,
        _source_type := 'delivery_note',
        _source_id := p_dn_id,
        _created_by := p_user_id,
        _is_closing := false,
        _is_adjusting := false,
        _lines := v_cogs_lines,
        _currency := v_currency,
        _exchange_rate := NULL,
        _source_subtype := 'cogs',
        _branch_id := v_branch_id
      );
    END IF;
  END IF;

  UPDATE public.delivery_notes
     SET status = 'delivered',
         delivered_at = now(),
         received_by = COALESCE(p_received_by, received_by),
         updated_at = now()
   WHERE id = p_dn_id;

  IF v_so_id IS NOT NULL THEN
    SELECT bool_and(quantity_fulfilled >= quantity), bool_or(quantity_fulfilled > 0)
      INTO v_all_fulfilled, v_any_fulfilled
      FROM public.sales_order_items
     WHERE sales_order_id = v_so_id;

    IF v_all_fulfilled THEN
      UPDATE public.sales_orders SET status = 'fulfilled', updated_at = now()
       WHERE id = v_so_id AND status NOT IN ('invoiced','cancelled');
    ELSIF v_any_fulfilled THEN
      UPDATE public.sales_orders SET status = 'partial', updated_at = now()
       WHERE id = v_so_id AND status NOT IN ('invoiced','cancelled','fulfilled');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'delivery_id', p_dn_id,
    'warehouse_id', v_warehouse_id,
    'movements_created', v_movement_count,
    'gl_posted', v_journal_id IS NOT NULL,
    'cogs_total', v_total_cogs
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_delivery_atomic(uuid, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.confirm_invoice_and_release_stock_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_main_lines jsonb,
  p_release_stock boolean DEFAULT true,
  p_warehouse_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_confirm jsonb;
  v_status text;
  v_dn_id uuid;
  v_delivery jsonb;
BEGIN
  SELECT status::text INTO v_status
    FROM public.invoices
   WHERE id = p_invoice_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found', p_invoice_id;
  END IF;

  IF v_status = 'draft' THEN
    v_confirm := public.confirm_invoice_atomic(
      p_invoice_id := p_invoice_id,
      p_user_id := p_user_id,
      p_main_lines := p_main_lines,
      p_cogs_lines := NULL
    );
  ELSE
    v_confirm := jsonb_build_object('success', true);
  END IF;

  SELECT dn.id INTO v_dn_id
    FROM public.delivery_notes dn
    JOIN public.invoices i ON i.id = p_invoice_id
   WHERE dn.organization_id = i.organization_id
     AND dn.business_id = i.business_id
     AND (
       (dn.notes IS NOT NULL AND dn.notes LIKE '%[auto-from-invoice:' || p_invoice_id::text || ']%')
       OR (i.source_sales_order_id IS NOT NULL AND dn.sales_order_id = i.source_sales_order_id)
     )
   ORDER BY dn.created_at DESC
   LIMIT 1;

  IF p_release_stock AND v_dn_id IS NOT NULL THEN
    v_delivery := public.complete_delivery_atomic(v_dn_id, p_user_id, p_user_id::text);
    IF NOT COALESCE((v_delivery->>'success')::boolean, false) THEN
      RAISE EXCEPTION 'Stock release failed: %', COALESCE(v_delivery->>'error', 'unknown error');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_confirm->>'journal_entry_id',
    'delivery_note_id', v_dn_id,
    'stock_released', p_release_stock AND v_dn_id IS NOT NULL,
    'delivery_result', v_delivery
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_invoice_and_release_stock_atomic(uuid, uuid, jsonb, boolean, uuid) TO authenticated;

COMMENT ON FUNCTION public.complete_delivery_atomic(uuid, uuid, text) IS
  'Completes a delivery note by writing traceable stock_movements and posting COGS through post_journal_entry_atomic. Never writes stale journal_entries.memo.';

COMMENT ON FUNCTION public.confirm_invoice_and_release_stock_atomic(uuid, uuid, jsonb, boolean, uuid) IS
  'One-action direct invoice workflow: confirm invoice and optionally validate the linked delivery note so stock is released through traceable movements.';