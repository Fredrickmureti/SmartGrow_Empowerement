-- ============================================================
-- Delivery Note Architecture Hardening — Round 5
-- ADR 0026: product master snapshotting, reservation symmetry,
--           universal over-delivery cap, single COGS locus,
--           first-class return delivery.
-- ============================================================

-- ---- 1. Snapshot columns on delivery_note_items -------------
ALTER TABLE public.delivery_note_items
  ADD COLUMN IF NOT EXISTS product_name_snapshot text,
  ADD COLUMN IF NOT EXISTS product_sku_snapshot  text,
  ADD COLUMN IF NOT EXISTS uom_snapshot          text,
  ADD COLUMN IF NOT EXISTS cost_at_shipment      numeric(18,6);

COMMENT ON COLUMN public.delivery_note_items.product_name_snapshot IS
  'Frozen product name at DN insert. UI/PDF must read this, never products.name.';
COMMENT ON COLUMN public.delivery_note_items.product_sku_snapshot IS
  'Frozen product SKU at DN insert.';
COMMENT ON COLUMN public.delivery_note_items.uom_snapshot IS
  'Frozen base UoM code at DN insert.';
COMMENT ON COLUMN public.delivery_note_items.cost_at_shipment IS
  'Cost used for COGS JE at goods-issue time. Populated by complete_delivery_atomic. NEVER recomputed.';

-- ---- 2. Return-DN linkage (SAP "LR" pattern: reuse delivery_notes) ----
ALTER TABLE public.delivery_notes
  ADD COLUMN IF NOT EXISTS return_of_dn_id uuid REFERENCES public.delivery_notes(id),
  ADD COLUMN IF NOT EXISTS is_return boolean NOT NULL DEFAULT false;

ALTER TABLE public.delivery_notes DROP CONSTRAINT IF EXISTS delivery_notes_status_check;
ALTER TABLE public.delivery_notes ADD CONSTRAINT delivery_notes_status_check
  CHECK (status = ANY (ARRAY['pending','ready_to_dispatch','dispatched','in_transit',
                             'delivered','partial','cancelled','returned']));

CREATE INDEX IF NOT EXISTS idx_delivery_notes_return_of_dn_id
  ON public.delivery_notes(return_of_dn_id) WHERE return_of_dn_id IS NOT NULL;

-- ---- 3. BEFORE INSERT trigger: auto-fill product snapshots no matter who inserts ----
CREATE OR REPLACE FUNCTION public._dni_fill_product_snapshots()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.product_name_snapshot IS NULL
     OR NEW.product_sku_snapshot IS NULL
     OR NEW.uom_snapshot IS NULL THEN
    SELECT
      COALESCE(NEW.product_name_snapshot, p.name),
      COALESCE(NEW.product_sku_snapshot,  p.sku),
      COALESCE(NEW.uom_snapshot, uom.code)
      INTO NEW.product_name_snapshot, NEW.product_sku_snapshot, NEW.uom_snapshot
      FROM public.products p
 LEFT JOIN public.units_of_measure uom ON uom.id = p.base_uom_id
     WHERE p.id = NEW.product_id;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_dni_fill_product_snapshots ON public.delivery_note_items;
CREATE TRIGGER trg_dni_fill_product_snapshots
BEFORE INSERT ON public.delivery_note_items
FOR EACH ROW EXECUTE FUNCTION public._dni_fill_product_snapshots();

-- ---- 4. restore_so_reservation: symmetric inverse of consume_so_reservation ----
CREATE OR REPLACE FUNCTION public.restore_so_reservation(
  p_org_id uuid, p_so_id uuid, p_product_id uuid, p_qty numeric
) RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_remaining numeric := p_qty;
  v_res RECORD;
  v_give numeric;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 OR p_product_id IS NULL THEN RETURN 0; END IF;

  -- Walk reservations newest-first. Restore previously-released rows up to
  -- their original requested quantity (heuristic: any released row may absorb
  -- up to p_qty since the canonical SO line quantity bounds total demand).
  FOR v_res IN
    SELECT id, business_id, warehouse_id, quantity, released_at,
           COALESCE((metadata->>'original_quantity')::numeric, NULLIF(quantity,0)) AS original_qty
      FROM public.stock_reservations
     WHERE organization_id = p_org_id
       AND source_type = 'sales_order'
       AND source_id   = p_so_id
       AND product_id  = p_product_id
     ORDER BY created_at DESC
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;

    IF v_res.released_at IS NOT NULL THEN
      v_give := LEAST(COALESCE(v_res.original_qty, v_remaining), v_remaining);
      UPDATE public.stock_reservations
         SET quantity = v_give, released_at = NULL
       WHERE id = v_res.id;
      UPDATE public.warehouse_stock
         SET reserved_quantity = COALESCE(reserved_quantity, 0) + v_give,
             updated_at = now()
       WHERE organization_id = p_org_id
         AND business_id     = v_res.business_id
         AND product_id      = p_product_id
         AND warehouse_id    = v_res.warehouse_id;
      v_remaining := v_remaining - v_give;
    ELSIF v_res.quantity < COALESCE(v_res.original_qty, v_res.quantity) THEN
      v_give := LEAST(COALESCE(v_res.original_qty,0) - v_res.quantity, v_remaining);
      UPDATE public.stock_reservations
         SET quantity = quantity + v_give
       WHERE id = v_res.id;
      UPDATE public.warehouse_stock
         SET reserved_quantity = COALESCE(reserved_quantity, 0) + v_give,
             updated_at = now()
       WHERE organization_id = p_org_id
         AND business_id     = v_res.business_id
         AND product_id      = p_product_id
         AND warehouse_id    = v_res.warehouse_id;
      v_remaining := v_remaining - v_give;
    END IF;
  END LOOP;

  RETURN p_qty - v_remaining;
END $$;

GRANT EXECUTE ON FUNCTION public.restore_so_reservation(uuid,uuid,uuid,numeric) TO authenticated;

-- ---- 5. Drop legacy 4-arg confirm_invoice_atomic, replace with 3-arg ----
DROP FUNCTION IF EXISTS public.confirm_invoice_atomic(uuid, uuid, jsonb, jsonb);

CREATE OR REPLACE FUNCTION public.confirm_invoice_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_main_lines jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_inv record; v_je_id uuid; v_main_entry_no text;
  v_line_count integer; v_items_subtotal numeric := 0; v_items_tax numeric := 0;
  v_main_debits numeric := 0; v_main_credits numeric := 0;
  v_bad_accounts integer := 0; v_revenue_line_count integer := 0;
  v_ar_line_count integer := 0;
  v_existing_dn_id uuid; v_stockable_count integer := 0;
  v_dn_id uuid; v_dn_number text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice % not found', p_invoice_id; END IF;
  IF v_inv.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft invoices can be confirmed (current: %)', v_inv.status;
  END IF;
  IF v_inv.contact_id IS NULL THEN
    RAISE EXCEPTION 'A customer is required to confirm this invoice. Please select a customer and try again.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_inv.business_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_inv.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_inv.business_id USING ERRCODE = '42501';
  END IF;
  IF v_inv.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Invoice % is already linked to a journal entry', v_inv.invoice_number;
  END IF;

  PERFORM public.assert_contact_in_business(v_inv.contact_id, v_inv.organization_id, v_inv.business_id, 'invoice customer');
  PERFORM public.assert_no_existing_source_posting(v_inv.organization_id, 'invoice', p_invoice_id, NULL);

  IF p_main_lines IS NULL OR jsonb_typeof(p_main_lines) <> 'array' OR jsonb_array_length(p_main_lines) < 2 THEN
    RAISE EXCEPTION 'Invoice JE requires at least 2 lines';
  END IF;

  SELECT COUNT(*), COALESCE(ROUND(SUM(line_total), 2), 0), COALESCE(ROUND(SUM(COALESCE(tax_amount, 0)), 2), 0)
    INTO v_line_count, v_items_subtotal, v_items_tax
  FROM public.invoice_items WHERE invoice_id = p_invoice_id;
  IF v_line_count = 0 THEN RAISE EXCEPTION 'Invoice % has no lines; cannot confirm', v_inv.invoice_number; END IF;
  IF ABS(v_items_subtotal - COALESCE(v_inv.subtotal, 0)) > 0.01
     OR ABS(v_items_tax - COALESCE(v_inv.tax_amount, 0)) > 0.01
     OR ABS(ROUND(v_items_subtotal + v_items_tax - COALESCE(v_inv.discount_amount, 0), 2) - COALESCE(v_inv.total, 0)) > 0.01 THEN
    RAISE EXCEPTION 'Invoice % totals do not match persisted line data', v_inv.invoice_number;
  END IF;

  SELECT
    COALESCE(SUM((l->>'debit')::numeric), 0),
    COALESCE(SUM((l->>'credit')::numeric), 0),
    COUNT(*) FILTER (WHERE a.id IS NULL),
    COUNT(*) FILTER (WHERE a.account_type = 'income' AND (l->>'credit')::numeric > 0),
    COUNT(*) FILTER (WHERE a.account_type = 'asset' AND a.detail_type = 'accounts_receivable' AND (l->>'debit')::numeric > 0)
  INTO v_main_debits, v_main_credits, v_bad_accounts, v_revenue_line_count, v_ar_line_count
  FROM jsonb_array_elements(p_main_lines) l
  LEFT JOIN public.accounts a ON a.id = (l->>'account_id')::uuid
                              AND a.organization_id = v_inv.organization_id
                              AND a.business_id = v_inv.business_id;

  IF v_bad_accounts > 0 THEN RAISE EXCEPTION 'Invoice JE references % accounts not in this business', v_bad_accounts; END IF;
  IF ABS(v_main_debits - v_main_credits) > 0.01 THEN RAISE EXCEPTION 'Invoice JE not balanced: debits % credits %', v_main_debits, v_main_credits; END IF;
  IF v_revenue_line_count = 0 OR v_ar_line_count = 0 THEN RAISE EXCEPTION 'Invoice JE missing required AR or Revenue line'; END IF;

  SELECT public.get_next_journal_entry_number(v_inv.organization_id) INTO v_main_entry_no;
  v_je_id := public.post_journal_entry_atomic(
    _org_id := v_inv.organization_id, _business_id := v_inv.business_id,
    _entry_number := v_main_entry_no, _entry_date := v_inv.issue_date,
    _reference := v_inv.invoice_number, _description := 'Invoice ' || v_inv.invoice_number,
    _source_type := 'invoice', _source_id := p_invoice_id,
    _created_by := p_user_id, _is_closing := false, _is_adjusting := false,
    _lines := p_main_lines, _currency := v_inv.currency,
    _exchange_rate := NULL, _source_subtype := NULL, _branch_id := v_inv.branch_id
  );

  UPDATE public.invoices
    SET status = 'confirmed', journal_entry_id = v_je_id, updated_at = now()
   WHERE id = p_invoice_id;

  IF v_inv.source_sales_order_id IS NULL THEN
    SELECT id INTO v_existing_dn_id FROM public.delivery_notes
      WHERE source_invoice_id = p_invoice_id LIMIT 1;

    IF v_existing_dn_id IS NULL THEN
      SELECT COUNT(*) INTO v_stockable_count
        FROM public.invoice_items ii
        JOIN public.products p ON p.id = ii.product_id
       WHERE ii.invoice_id = p_invoice_id
         AND COALESCE(p.track_inventory, true) = true
         AND p.type = 'product'
         AND COALESCE(ii.quantity, 0) > 0;

      IF v_stockable_count > 0 THEN
        v_dn_number := public.get_next_delivery_number(v_inv.organization_id);
        INSERT INTO public.delivery_notes (
          organization_id, business_id, branch_id,
          contact_id, delivery_number, delivery_date, status,
          sales_order_id, source_invoice_id, received_by_contact_id,
          notes, created_by
        ) VALUES (
          v_inv.organization_id, v_inv.business_id, v_inv.branch_id,
          v_inv.contact_id, v_dn_number, v_inv.issue_date, 'pending',
          NULL, p_invoice_id, v_inv.contact_id, NULL, p_user_id
        ) RETURNING id INTO v_dn_id;

        -- snapshots filled by trigger; explicit insert kept for clarity
        INSERT INTO public.delivery_note_items (
          delivery_note_id, product_id, description,
          quantity_ordered, quantity_delivered, sort_order
        )
        SELECT
          v_dn_id, ii.product_id, ii.description,
          ii.quantity, ii.quantity, COALESCE(ii.sort_order, 0)
        FROM public.invoice_items ii
        JOIN public.products p ON p.id = ii.product_id
       WHERE ii.invoice_id = p_invoice_id
         AND COALESCE(p.track_inventory, true) = true
         AND p.type = 'product'
         AND COALESCE(ii.quantity, 0) > 0;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_je_id,
    'delivery_note_id', v_dn_id,
    'delivery_number', v_dn_number,
    'auto_delivery_created', v_dn_id IS NOT NULL
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.confirm_invoice_atomic(uuid,uuid,jsonb) TO authenticated;

-- ---- 6. confirm_invoice_and_release_stock_atomic: drop legacy 4-arg call ----
CREATE OR REPLACE FUNCTION public.confirm_invoice_and_release_stock_atomic(
  p_invoice_id uuid, p_user_id uuid, p_main_lines jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_confirm jsonb;
  v_dn_id uuid;
  v_complete jsonb;
BEGIN
  v_confirm := public.confirm_invoice_atomic(p_invoice_id, p_user_id, p_main_lines);
  v_dn_id := NULLIF(v_confirm->>'delivery_note_id','')::uuid;
  IF v_dn_id IS NOT NULL THEN
    v_complete := public.complete_delivery_atomic(v_dn_id, p_user_id, NULL, NULL, p_user_id);
    v_confirm := v_confirm || jsonb_build_object('delivery_completion', v_complete);
  END IF;
  RETURN v_confirm;
END $$;

GRANT EXECUTE ON FUNCTION public.confirm_invoice_and_release_stock_atomic(uuid,uuid,jsonb) TO authenticated;

-- Drop legacy 4-arg overload if still present
DROP FUNCTION IF EXISTS public.confirm_invoice_and_release_stock_atomic(uuid, uuid, jsonb, jsonb);

-- ---- 7. complete_delivery_atomic: SO cap + cost snapshot + return-aware GL ----
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
  v_so_ordered_qty numeric; v_so_sibling_qty numeric;
  v_is_return boolean;
  v_mov_type text; v_mov_sign int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;

  IF p_received_by IS NOT NULL AND p_received_by ~ '^[0-9a-fA-F-]{36}$' THEN
    RAISE EXCEPTION 'p_received_by must be a recipient name, not a user id (got %). Pass the staff user id via p_received_by_user_id.', p_received_by
      USING ERRCODE='22023';
  END IF;
  v_received_by_clean := NULLIF(btrim(COALESCE(p_received_by, '')), '');

  SELECT id, organization_id, business_id, branch_id, sales_order_id, source_invoice_id,
         delivery_number, status, auto_invoice_on_complete, spawned_invoice_id, contact_id,
         COALESCE(is_return, false) AS is_return, return_of_dn_id
    INTO v_dn FROM public.delivery_notes WHERE id = p_dn_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Delivery note not found'); END IF;

  IF v_dn.status IN ('delivered','partial','cancelled','returned') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery already finalised');
  END IF;

  v_org_id := v_dn.organization_id;
  v_biz_id := v_dn.business_id;
  v_so_id  := v_dn.sales_order_id;
  v_is_return := v_dn.is_return;

  IF v_biz_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_biz_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_biz_id USING ERRCODE='42501';
  END IF;

  -- Over-delivery cap: invoice-sourced OR SO-sourced, both enforced.
  IF NOT v_is_return AND v_dn.source_invoice_id IS NOT NULL THEN
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

  IF NOT v_is_return AND v_so_id IS NOT NULL THEN
    FOR v_item IN
      SELECT dni.product_id, SUM(dni.quantity_delivered) AS qty
        FROM public.delivery_note_items dni
       WHERE dni.delivery_note_id = p_dn_id AND dni.quantity_delivered > 0
         AND dni.product_id IS NOT NULL
       GROUP BY dni.product_id
    LOOP
      SELECT COALESCE(SUM(soi.quantity), 0) INTO v_so_ordered_qty
        FROM public.sales_order_items soi
       WHERE soi.sales_order_id = v_so_id AND soi.product_id = v_item.product_id;
      SELECT COALESCE(SUM(sdni.quantity_delivered), 0) INTO v_so_sibling_qty
        FROM public.delivery_notes sdn
        JOIN public.delivery_note_items sdni ON sdni.delivery_note_id = sdn.id
       WHERE sdn.sales_order_id = v_so_id
         AND sdn.id <> p_dn_id AND sdn.status IN ('delivered','partial')
         AND sdni.product_id = v_item.product_id;
      IF v_so_ordered_qty > 0 AND (v_so_sibling_qty + v_item.qty) > v_so_ordered_qty THEN
        RAISE EXCEPTION 'Over-delivery blocked: product % — ordered %, already delivered %, attempting % more (would exceed SO)',
          v_item.product_id, v_so_ordered_qty, v_so_sibling_qty, v_item.qty USING ERRCODE='22023';
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

  -- Movement type & sign chosen by document direction
  v_mov_type := CASE WHEN v_is_return THEN 'return_in' ELSE 'delivery' END;
  v_mov_sign := CASE WHEN v_is_return THEN  1 ELSE -1 END;

  FOR v_item IN
    SELECT dni.id, dni.product_id, dni.description, dni.quantity_ordered, dni.quantity_delivered,
           dni.sales_order_item_id, dni.lot_allocations, dni.lot_number, dni.serial_number,
           dni.cost_at_shipment,
           p.cost_price, p.track_inventory, COALESCE(p.is_lot_tracked,false) AS is_lot_tracked
      FROM public.delivery_note_items dni
 LEFT JOIN public.products p ON p.id = dni.product_id
     WHERE dni.delivery_note_id = p_dn_id AND dni.quantity_delivered > 0
  LOOP
    IF v_item.quantity_delivered < v_item.quantity_ordered THEN
      v_is_partial := true;
    END IF;

    IF NOT v_is_return AND v_item.sales_order_item_id IS NOT NULL THEN
      UPDATE public.sales_order_items
         SET quantity_fulfilled = COALESCE(quantity_fulfilled, 0) + v_item.quantity_delivered
       WHERE id = v_item.sales_order_item_id;
    ELSIF v_is_return AND v_item.sales_order_item_id IS NOT NULL THEN
      UPDATE public.sales_order_items
         SET quantity_fulfilled = GREATEST(COALESCE(quantity_fulfilled, 0) - v_item.quantity_delivered, 0)
       WHERE id = v_item.sales_order_item_id;
    END IF;

    IF NOT v_is_return AND v_so_id IS NOT NULL AND v_item.product_id IS NOT NULL
       AND COALESCE(v_item.track_inventory, true) THEN
      PERFORM public.consume_so_reservation(v_org_id, v_so_id, v_item.product_id, v_item.quantity_delivered);
    END IF;

    IF v_item.product_id IS NULL OR NOT COALESCE(v_item.track_inventory, true) THEN CONTINUE; END IF;

    -- Cost: for returns, use the original DN line's snapshotted cost; for normal
    -- deliveries, snapshot the current cost_price NOW and persist it on the line.
    IF v_is_return AND v_dn.return_of_dn_id IS NOT NULL THEN
      SELECT odni.cost_at_shipment INTO v_unit_cost
        FROM public.delivery_note_items odni
       WHERE odni.delivery_note_id = v_dn.return_of_dn_id
         AND odni.product_id = v_item.product_id
       ORDER BY odni.cost_at_shipment IS NULL, odni.id LIMIT 1;
      v_unit_cost := COALESCE(v_unit_cost, v_item.cost_at_shipment, v_item.cost_price, 0);
    ELSE
      v_unit_cost := COALESCE(v_item.cost_at_shipment, v_item.cost_price, 0);
    END IF;

    -- Persist cost_at_shipment so historical COGS is recoverable forever.
    IF v_item.cost_at_shipment IS NULL THEN
      UPDATE public.delivery_note_items
         SET cost_at_shipment = v_unit_cost
       WHERE id = v_item.id;
    END IF;

    v_is_lot_tracked := v_item.is_lot_tracked;

    IF v_is_lot_tracked THEN
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
      ELSIF NOT v_is_return THEN
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
      ELSE
        -- Return without explicit allocations: required for lot-tracked items.
        RAISE EXCEPTION 'Return of lot-tracked product % requires explicit lot_allocations', v_item.product_id
          USING ERRCODE='check_violation';
      END IF;

      PERFORM public.consume_lots_atomic(
        v_org_id, v_biz_id, v_warehouse_id, v_branch_id,
        v_item.product_id, v_mov_type,
        'delivery_note', p_dn_id, p_user_id,
        CASE WHEN v_is_return THEN 'Return ' ELSE 'Delivery ' END || v_dn.delivery_number || COALESCE(' — ' || v_item.description, ''),
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
        v_item.product_id, v_mov_type, v_mov_sign * ABS(v_item.quantity_delivered), v_unit_cost,
        'delivery_note', p_dn_id,
        CASE WHEN v_is_return THEN 'Return ' ELSE 'Delivery ' END || v_dn.delivery_number || COALESCE(' — ' || v_item.description, ''),
        p_user_id
      );
      v_movement_count := v_movement_count + 1;
    END IF;

    IF v_is_return AND v_so_id IS NOT NULL AND v_item.product_id IS NOT NULL
       AND COALESCE(v_item.track_inventory, true) THEN
      PERFORM public.restore_so_reservation(v_org_id, v_so_id, v_item.product_id, v_item.quantity_delivered);
    END IF;

    v_line_cost := ABS(v_item.quantity_delivered) * v_unit_cost;
    v_total_cogs := v_total_cogs + v_line_cost;
  END LOOP;

  -- GL: normal delivery posts DR COGS / CR Inventory.
  --     Return delivery posts the symmetric DR Inventory / CR COGS.
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
      IF v_is_return THEN
        v_cogs_lines := jsonb_build_array(
          jsonb_build_object('account_id', v_inventory_acct, 'debit', v_total_cogs, 'credit', 0,
                             'description', 'Inventory restore - ' || v_dn.delivery_number),
          jsonb_build_object('account_id', v_cogs_acct, 'debit', 0, 'credit', v_total_cogs,
                             'description', 'COGS reversal - ' || v_dn.delivery_number)
        );
      ELSE
        v_cogs_lines := jsonb_build_array(
          jsonb_build_object('account_id', v_cogs_acct, 'debit', v_total_cogs, 'credit', 0,
                             'description', 'COGS - ' || v_dn.delivery_number),
          jsonb_build_object('account_id', v_inventory_acct, 'debit', 0, 'credit', v_total_cogs,
                             'description', 'Inventory reduction - ' || v_dn.delivery_number)
        );
      END IF;
      v_journal_id := public.post_journal_entry_atomic(
        _org_id := v_org_id, _business_id := v_biz_id,
        _entry_number := v_entry_no, _entry_date := CURRENT_DATE,
        _reference := CASE WHEN v_is_return THEN 'COGS-REV-' ELSE 'COGS-' END || v_dn.delivery_number,
        _description := CASE WHEN v_is_return THEN 'COGS reversal for return ' ELSE 'COGS for delivery ' END || v_dn.delivery_number,
        _source_type := 'delivery_note', _source_id := p_dn_id,
        _created_by := p_user_id, _is_closing := false, _is_adjusting := false,
        _lines := v_cogs_lines, _currency := v_currency, _exchange_rate := NULL,
        _source_subtype := CASE WHEN v_is_return THEN 'cogs_reversal' ELSE 'cogs' END,
        _branch_id := v_branch_id
      );
    END IF;
  END IF;

  v_pod_contact := NULLIF(p_pod->>'received_by_contact_id','')::uuid;

  UPDATE public.delivery_notes
     SET status = CASE WHEN v_is_return THEN 'returned'
                       WHEN v_is_partial THEN 'partial'
                       ELSE 'delivered' END,
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

  IF NOT v_is_return AND v_so_id IS NOT NULL THEN
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

  -- Auto-spawn invoice only for outbound deliveries
  IF NOT v_is_return AND COALESCE(v_dn.auto_invoice_on_complete, true)
     AND v_dn.source_invoice_id IS NULL AND v_dn.spawned_invoice_id IS NULL
     AND v_dn.contact_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.delivery_note_items
                  WHERE delivery_note_id = p_dn_id AND quantity_delivered > 0 AND unit_price IS NOT NULL)
  THEN
    v_spawned := public.create_invoice_from_delivery_atomic(p_dn_id, p_user_id);
    v_spawned_invoice_id := (v_spawned->>'invoice_id')::uuid;
    v_spawned_invoice_number := v_spawned->>'invoice_number';
  END IF;

  PERFORM public._log_dn_event(p_dn_id, CASE WHEN v_is_return THEN 'returned'
                                              WHEN v_is_partial THEN 'partially_delivered'
                                              ELSE 'delivered' END,
    p_user_id, v_received_by_clean,
    jsonb_build_object('movements', v_movement_count, 'cogs', v_total_cogs, 'pod_id', v_pod_id,
                       'spawned_invoice_id', v_spawned_invoice_id,
                       'spawned_invoice_number', v_spawned_invoice_number,
                       'is_return', v_is_return));

  RETURN jsonb_build_object(
    'success', true, 'delivery_id', p_dn_id, 'warehouse_id', v_warehouse_id,
    'movements_created', v_movement_count, 'gl_posted', v_journal_id IS NOT NULL,
    'cogs_total', v_total_cogs, 'pod_id', v_pod_id, 'partial', v_is_partial,
    'is_return', v_is_return,
    'spawned_invoice_id', v_spawned_invoice_id,
    'spawned_invoice_number', v_spawned_invoice_number
  );
END $function$;

GRANT EXECUTE ON FUNCTION public.complete_delivery_atomic(uuid,uuid,text,jsonb,uuid) TO authenticated;

-- ---- 8. cancel_delivery_atomic: restore reservations + reverse sales_order_items.quantity_fulfilled ----
CREATE OR REPLACE FUNCTION public.cancel_delivery_atomic(
  p_dn_id uuid, p_user_id uuid, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_dn record;
  v_mov record;
  v_line record;
  v_compensating_count int := 0;
  v_je record;
  v_voided_je_ids uuid[] := ARRAY[]::uuid[];
  v_inv record;
  v_inv_status_after text;
  v_reservations_restored int := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE='42501';
  END IF;

  SELECT id, organization_id, business_id, branch_id, delivery_number,
         status, spawned_invoice_id, source_invoice_id, sales_order_id,
         COALESCE(is_return,false) AS is_return
    INTO v_dn
    FROM public.delivery_notes
   WHERE id = p_dn_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery note % not found', p_dn_id USING ERRCODE='P0002';
  END IF;

  IF NOT public.user_can_access_business(p_user_id, v_dn.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_dn.business_id USING ERRCODE='42501';
  END IF;

  IF v_dn.status = 'cancelled' THEN
    RETURN jsonb_build_object('success', true, 'already_cancelled', true);
  END IF;

  IF v_dn.spawned_invoice_id IS NOT NULL THEN
    SELECT id, invoice_number, status INTO v_inv
      FROM public.invoices WHERE id = v_dn.spawned_invoice_id FOR UPDATE;
    IF v_inv.status NOT IN ('draft','cancelled') THEN
      RAISE EXCEPTION 'Linked invoice % is %, not draft — reverse the invoice first',
        v_inv.invoice_number, v_inv.status USING ERRCODE='P0001';
    END IF;
    IF v_inv.status = 'draft' THEN
      UPDATE public.invoices SET status='cancelled', updated_at=now() WHERE id=v_inv.id;
      v_inv_status_after := 'cancelled';
    ELSE
      v_inv_status_after := v_inv.status;
    END IF;
  END IF;

  IF v_dn.status IN ('delivered','partial','returned') THEN
    -- Compensating stock movements
    FOR v_mov IN
      SELECT id, organization_id, business_id, branch_id, warehouse_id,
             product_id, quantity, unit_cost
        FROM public.stock_movements
       WHERE reference_type = 'delivery_note' AND reference_id = p_dn_id
         AND movement_type IN ('delivery','return_in')
    LOOP
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, warehouse_id,
        product_id, movement_type, quantity, unit_cost,
        reference_type, reference_id, notes, created_by
      ) VALUES (
        v_mov.organization_id, v_mov.business_id, v_mov.branch_id, v_mov.warehouse_id,
        v_mov.product_id, 'delivery_cancel', -v_mov.quantity, v_mov.unit_cost,
        'delivery_note', p_dn_id,
        'Cancellation of delivery ' || v_dn.delivery_number, p_user_id
      );
      v_compensating_count := v_compensating_count + 1;
    END LOOP;

    -- Reverse SO line fulfillment + restore reservations (outbound DNs only)
    IF NOT v_dn.is_return AND v_dn.sales_order_id IS NOT NULL THEN
      FOR v_line IN
        SELECT dni.product_id, dni.quantity_delivered, dni.sales_order_item_id
          FROM public.delivery_note_items dni
         WHERE dni.delivery_note_id = p_dn_id
           AND dni.quantity_delivered > 0
           AND dni.product_id IS NOT NULL
      LOOP
        IF v_line.sales_order_item_id IS NOT NULL THEN
          UPDATE public.sales_order_items
             SET quantity_fulfilled = GREATEST(COALESCE(quantity_fulfilled,0) - v_line.quantity_delivered, 0)
           WHERE id = v_line.sales_order_item_id;
        END IF;
        PERFORM public.restore_so_reservation(
          v_dn.organization_id, v_dn.sales_order_id, v_line.product_id, v_line.quantity_delivered);
        v_reservations_restored := v_reservations_restored + 1;
      END LOOP;

      -- Recompute SO header status
      UPDATE public.sales_orders so
         SET status = CASE
           WHEN NOT EXISTS (SELECT 1 FROM public.sales_order_items WHERE sales_order_id = so.id AND quantity_fulfilled > 0)
                AND so.status IN ('fulfilled','partial') THEN 'confirmed'
           WHEN EXISTS (SELECT 1 FROM public.sales_order_items WHERE sales_order_id = so.id AND quantity_fulfilled < quantity)
                AND so.status = 'fulfilled' THEN 'partial'
           ELSE so.status END,
             updated_at = now()
       WHERE id = v_dn.sales_order_id AND status NOT IN ('cancelled','invoiced');
    END IF;

    -- Void DN-sourced journal entries
    FOR v_je IN
      SELECT id FROM public.journal_entries
       WHERE source_type = 'delivery_note' AND source_id = p_dn_id
         AND status = 'posted'
    LOOP
      PERFORM public.void_journal_entry_atomic(
        _entry_id := v_je.id,
        _reason   := COALESCE('DN cancel: ' || p_reason, 'Delivery cancelled'),
        _user_id  := p_user_id
      );
      v_voided_je_ids := array_append(v_voided_je_ids, v_je.id);
    END LOOP;
  END IF;

  UPDATE public.delivery_notes
     SET status = 'cancelled',
         cancelled_at = now(),
         cancelled_by = p_user_id,
         cancellation_reason = p_reason,
         updated_at = now()
   WHERE id = p_dn_id;

  PERFORM public._log_dn_event(p_dn_id, 'cancelled', p_user_id, NULL,
    jsonb_build_object(
      'reason', p_reason,
      'compensating_movements', v_compensating_count,
      'reservations_restored', v_reservations_restored,
      'voided_journal_entries', v_voided_je_ids,
      'spawned_invoice_id', v_dn.spawned_invoice_id,
      'spawned_invoice_status_after', v_inv_status_after
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'delivery_id', p_dn_id,
    'compensating_movements', v_compensating_count,
    'reservations_restored', v_reservations_restored,
    'voided_journal_entries', v_voided_je_ids,
    'spawned_invoice_id', v_dn.spawned_invoice_id,
    'spawned_invoice_status_after', v_inv_status_after
  );
END $$;

GRANT EXECUTE ON FUNCTION public.cancel_delivery_atomic(uuid,uuid,text) TO authenticated;

-- ---- 9. create_return_delivery_atomic — first-class return DN ----
CREATE OR REPLACE FUNCTION public.create_return_delivery_atomic(
  p_original_dn_id uuid,
  p_user_id uuid,
  p_lines jsonb,          -- [{ product_id, quantity, lot_allocations? }]
  p_reason text DEFAULT NULL,
  p_post_immediately boolean DEFAULT true
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_orig record;
  v_new_id uuid;
  v_dn_number text;
  v_line jsonb;
  v_prod_id uuid;
  v_qty numeric;
  v_orig_line record;
  v_complete jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_orig FROM public.delivery_notes WHERE id = p_original_dn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original delivery note % not found', p_original_dn_id; END IF;
  IF v_orig.status NOT IN ('delivered','partial') THEN
    RAISE EXCEPTION 'Cannot return a delivery in status %', v_orig.status USING ERRCODE='check_violation';
  END IF;
  IF COALESCE(v_orig.is_return,false) THEN
    RAISE EXCEPTION 'Cannot return a return delivery (no chained returns)' USING ERRCODE='check_violation';
  END IF;
  IF NOT public.user_can_access_business(p_user_id, v_orig.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %' , v_orig.business_id USING ERRCODE='42501';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Return must include at least one line';
  END IF;

  v_dn_number := public.get_next_delivery_number(v_orig.organization_id);

  INSERT INTO public.delivery_notes (
    organization_id, business_id, branch_id,
    contact_id, delivery_number, delivery_date, status,
    sales_order_id, source_invoice_id, return_of_dn_id, is_return,
    notes, created_by
  ) VALUES (
    v_orig.organization_id, v_orig.business_id, v_orig.branch_id,
    v_orig.contact_id, v_dn_number, CURRENT_DATE, 'pending',
    v_orig.sales_order_id, v_orig.source_invoice_id, p_original_dn_id, true,
    p_reason, p_user_id
  ) RETURNING id INTO v_new_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_prod_id := NULLIF(v_line->>'product_id','')::uuid;
    v_qty     := (v_line->>'quantity')::numeric;
    IF v_prod_id IS NULL OR v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Each return line requires product_id and positive quantity';
    END IF;

    -- Cap by what was actually delivered (minus prior returns) on the original DN
    SELECT odni.id, odni.description, odni.sales_order_item_id,
           odni.quantity_delivered, odni.cost_at_shipment,
           odni.product_name_snapshot, odni.product_sku_snapshot, odni.uom_snapshot
      INTO v_orig_line
      FROM public.delivery_note_items odni
     WHERE odni.delivery_note_id = p_original_dn_id AND odni.product_id = v_prod_id
     ORDER BY odni.id LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product % was not in original delivery %', v_prod_id, v_orig.delivery_number;
    END IF;

    IF v_qty > v_orig_line.quantity_delivered THEN
      RAISE EXCEPTION 'Return qty % exceeds delivered qty % for product %',
        v_qty, v_orig_line.quantity_delivered, v_prod_id USING ERRCODE='check_violation';
    END IF;

    INSERT INTO public.delivery_note_items (
      delivery_note_id, product_id, description,
      quantity_ordered, quantity_delivered, sort_order,
      product_name_snapshot, product_sku_snapshot, uom_snapshot,
      cost_at_shipment, lot_allocations,
      sales_order_item_id
    ) VALUES (
      v_new_id, v_prod_id, v_orig_line.description,
      v_qty, v_qty, 0,
      v_orig_line.product_name_snapshot, v_orig_line.product_sku_snapshot, v_orig_line.uom_snapshot,
      v_orig_line.cost_at_shipment,
      v_line->'lot_allocations',
      v_orig_line.sales_order_item_id
    );
  END LOOP;

  IF p_post_immediately THEN
    v_complete := public.complete_delivery_atomic(v_new_id, p_user_id, NULL, NULL, p_user_id);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'return_delivery_id', v_new_id,
    'return_delivery_number', v_dn_number,
    'original_delivery_id', p_original_dn_id,
    'posted', p_post_immediately,
    'completion', v_complete
  );
END $$;

GRANT EXECUTE ON FUNCTION public.create_return_delivery_atomic(uuid,uuid,jsonb,text,boolean) TO authenticated;