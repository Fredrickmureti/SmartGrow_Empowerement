-- ============================================================
-- STAGE C — Atomic write paths + tighten stock_movements
-- ============================================================
-- C1: complete_goods_receipt_atomic(p_grn_id, p_user_id)
--     Replaces JS loop in GoodsReceiptDialog. Creates stock movements,
--     copies lot/serial from goods_receipt_items (D1 trace), updates PO
--     items, and posts GL (DR Inventory / CR GRNI).
-- C2: complete_delivery_atomic(p_dn_id, p_user_id, p_received_by)
--     Replaces JS loop in useDeliveryNotes.markAsDelivered. Creates
--     stock movements, posts COGS GL (DR COGS / CR Inventory). Validates
--     warehouse.branch_id == sales_order.branch_id (D3 coherence).
-- C3: Backfill + tighten stock_movements (business_id NOT NULL).
-- D1: Add lot_number / serial_number columns to stock_movements.

-- ============================================================
-- D1 PRE-REQUISITE — extend stock_movements with lot/serial columns
-- ============================================================
ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS lot_number TEXT,
  ADD COLUMN IF NOT EXISTS serial_number TEXT;

CREATE INDEX IF NOT EXISTS idx_stock_movements_product_lot
  ON public.stock_movements (product_id, lot_number)
  WHERE lot_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_movements_product_serial
  ON public.stock_movements (product_id, serial_number)
  WHERE serial_number IS NOT NULL;

-- ============================================================
-- C3a — Backfill stock_movements.business_id from warehouse
-- ============================================================
UPDATE public.stock_movements sm
SET business_id = w.business_id
FROM public.warehouses w
WHERE sm.warehouse_id = w.id
  AND sm.business_id IS NULL
  AND w.business_id IS NOT NULL;

-- ============================================================
-- C3b — Quarantine truly orphaned movements (no warehouse, no business)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.stock_movements_orphans (
  LIKE public.stock_movements INCLUDING ALL,
  quarantined_at timestamptz NOT NULL DEFAULT now(),
  quarantine_reason text
);

-- Disable trigger noise during quarantine move
INSERT INTO public.stock_movements_orphans
SELECT sm.*, now(), 'NULL business_id and NULL/missing warehouse'
FROM public.stock_movements sm
LEFT JOIN public.warehouses w ON w.id = sm.warehouse_id
WHERE sm.business_id IS NULL
  AND (sm.warehouse_id IS NULL OR w.id IS NULL);

DELETE FROM public.stock_movements sm
USING public.stock_movements_orphans o
WHERE sm.id = o.id;

-- ============================================================
-- C3c — Now safe to enforce NOT NULL on business_id
-- ============================================================
ALTER TABLE public.stock_movements
  ALTER COLUMN business_id SET NOT NULL;

-- ============================================================
-- C1 — complete_goods_receipt_atomic
-- ============================================================
CREATE OR REPLACE FUNCTION public.complete_goods_receipt_atomic(
  p_grn_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_grn          RECORD;
  v_po           RECORD;
  v_item         RECORD;
  v_warehouse_id uuid;
  v_branch_id    uuid;
  v_org_id       uuid;
  v_biz_id       uuid;
  v_inventory_acct uuid;
  v_grni_acct    uuid;
  v_journal_id   uuid;
  v_total_cost   numeric := 0;
  v_line_cost    numeric;
  v_unit_cost    numeric;
  v_movement_count int := 0;
  v_all_received boolean;
  v_any_received boolean := false;
BEGIN
  -- Lock GRN
  SELECT id, organization_id, business_id, warehouse_id, branch_id,
         purchase_order_id, receipt_number, status
    INTO v_grn
    FROM goods_receipts
   WHERE id = p_grn_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Goods receipt not found');
  END IF;

  IF v_grn.status = 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Goods receipt already completed');
  END IF;

  v_org_id       := v_grn.organization_id;
  v_biz_id       := v_grn.business_id;
  v_warehouse_id := v_grn.warehouse_id;

  IF v_warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Goods receipt has no warehouse — set warehouse_id before completing');
  END IF;

  -- Resolve branch from warehouse and validate scope
  SELECT business_id, branch_id
    INTO v_biz_id, v_branch_id
    FROM warehouses
   WHERE id = v_warehouse_id;

  IF v_biz_id IS NULL OR v_biz_id <> v_grn.business_id THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Warehouse does not belong to receipt company');
  END IF;

  -- Lock the PO
  SELECT id, po_number, status
    INTO v_po
    FROM purchase_orders
   WHERE id = v_grn.purchase_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Purchase order not found');
  END IF;

  -- Iterate receipt items: stock movement + accumulate inventory cost
  FOR v_item IN
    SELECT gri.id, gri.product_id, gri.purchase_order_item_id,
           gri.description, gri.quantity_received,
           gri.lot_number, gri.serial_number, gri.notes,
           poi.unit_price, poi.quantity AS po_quantity,
           poi.quantity_received AS po_qty_already_received,
           p.cost_price, p.track_inventory, p.inventory_account_id
      FROM goods_receipt_items gri
 LEFT JOIN purchase_order_items poi ON poi.id = gri.purchase_order_item_id
 LEFT JOIN products p ON p.id = gri.product_id
     WHERE gri.goods_receipt_id = p_grn_id
  LOOP
    v_any_received := true;

    IF v_item.product_id IS NOT NULL AND COALESCE(v_item.track_inventory, true) THEN
      v_unit_cost := COALESCE(v_item.unit_price, v_item.cost_price, 0);

      INSERT INTO stock_movements (
        organization_id, business_id, branch_id, warehouse_id,
        product_id, movement_type, quantity, unit_cost,
        reference_type, reference_id, notes,
        lot_number, serial_number,
        created_by
      ) VALUES (
        v_org_id, v_biz_id, v_branch_id, v_warehouse_id,
        v_item.product_id, 'receipt', v_item.quantity_received, v_unit_cost,
        'goods_receipt', p_grn_id,
        'GRN ' || v_grn.receipt_number || COALESCE(' — ' || v_item.description, ''),
        v_item.lot_number, v_item.serial_number,
        p_user_id
      );

      v_movement_count := v_movement_count + 1;

      v_line_cost := v_item.quantity_received * v_unit_cost;
      v_total_cost := v_total_cost + v_line_cost;
    END IF;

    -- Update PO item received qty + status
    IF v_item.purchase_order_item_id IS NOT NULL THEN
      UPDATE purchase_order_items
         SET quantity_received = COALESCE(quantity_received, 0) + v_item.quantity_received,
             receipt_status = CASE
               WHEN COALESCE(quantity_received, 0) + v_item.quantity_received >= quantity THEN 'received'
               ELSE 'partial'
             END
       WHERE id = v_item.purchase_order_item_id;
    END IF;
  END LOOP;

  -- Mark GRN completed
  UPDATE goods_receipts
     SET status = 'completed',
         updated_at = now()
   WHERE id = p_grn_id;

  -- Determine overall PO completion
  SELECT bool_and(COALESCE(quantity_received, 0) >= quantity)
    INTO v_all_received
    FROM purchase_order_items
   WHERE purchase_order_id = v_po.id;

  IF v_all_received THEN
    UPDATE purchase_orders SET status = 'received' WHERE id = v_po.id;
  ELSIF v_any_received THEN
    UPDATE purchase_orders SET status = 'partial_received' WHERE id = v_po.id;
  END IF;

  -- GL posting: DR Inventory / CR GRNI (Goods Received Not Invoiced)
  IF v_total_cost > 0 THEN
    SELECT id INTO v_inventory_acct
      FROM accounts
     WHERE organization_id = v_org_id
       AND business_id = v_biz_id
       AND detail_type = 'inventory'
       AND is_active = true
     LIMIT 1;

    SELECT id INTO v_grni_acct
      FROM accounts
     WHERE organization_id = v_org_id
       AND business_id = v_biz_id
       AND (detail_type = 'grni' OR code = '21100')
       AND is_active = true
     LIMIT 1;

    -- Auto-seed GRNI account if missing
    IF v_grni_acct IS NULL THEN
      INSERT INTO accounts (
        organization_id, business_id, code, name,
        account_type, detail_type, description, is_active, is_system
      ) VALUES (
        v_org_id, v_biz_id, '21100', 'Goods Received Not Invoiced',
        'liability', 'grni',
        'Accrual for inventory received but not yet invoiced (GRNI clearing)',
        true, true
      )
      RETURNING id INTO v_grni_acct;
    END IF;

    IF v_inventory_acct IS NOT NULL AND v_grni_acct IS NOT NULL THEN
      INSERT INTO journal_entries (
        organization_id, business_id, entry_date, reference, memo,
        source_type, source_id, status, created_by
      ) VALUES (
        v_org_id, v_biz_id, CURRENT_DATE,
        v_grn.receipt_number,
        'Inventory received — ' || v_grn.receipt_number,
        'goods_receipt', p_grn_id::text,
        'posted', p_user_id
      )
      RETURNING id INTO v_journal_id;

      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_amount, credit_amount, description)
      VALUES
        (v_journal_id, v_inventory_acct, v_total_cost, 0, 'Inventory in — ' || v_grn.receipt_number),
        (v_journal_id, v_grni_acct, 0, v_total_cost, 'GRNI accrual — ' || v_grn.receipt_number);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'grn_id', p_grn_id,
    'movements_created', v_movement_count,
    'total_cost', v_total_cost,
    'gl_posted', v_journal_id IS NOT NULL,
    'po_status', CASE WHEN v_all_received THEN 'received' ELSE 'partial_received' END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_goods_receipt_atomic(uuid, uuid) TO authenticated;

-- ============================================================
-- C2 — complete_delivery_atomic (with D3 SO↔DN branch coherence)
-- ============================================================
CREATE OR REPLACE FUNCTION public.complete_delivery_atomic(
  p_dn_id uuid,
  p_user_id uuid,
  p_received_by text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dn               RECORD;
  v_so_branch_id     uuid;
  v_warehouse_id     uuid;
  v_branch_id        uuid;
  v_org_id           uuid;
  v_biz_id           uuid;
  v_item             RECORD;
  v_unit_cost        numeric;
  v_line_cost        numeric;
  v_total_cogs       numeric := 0;
  v_inventory_acct   uuid;
  v_cogs_acct        uuid;
  v_journal_id       uuid;
  v_movement_count   int := 0;
BEGIN
  -- Lock the DN
  SELECT id, organization_id, business_id, branch_id, sales_order_id,
         delivery_number, status
    INTO v_dn
    FROM delivery_notes
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

  -- Resolve a warehouse for this delivery's branch
  SELECT id, branch_id INTO v_warehouse_id, v_branch_id
    FROM warehouses
   WHERE organization_id = v_org_id
     AND business_id = v_biz_id
     AND COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(v_dn.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND is_active = true
     AND COALESCE(is_in_transit, false) = false
   ORDER BY is_default DESC NULLS LAST
   LIMIT 1;

  IF v_warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error',
      'No active warehouse found for this branch — create one before delivering.');
  END IF;

  -- D3: SO ↔ DN branch coherence
  IF v_dn.sales_order_id IS NOT NULL THEN
    SELECT branch_id INTO v_so_branch_id
      FROM sales_orders
     WHERE id = v_dn.sales_order_id;

    IF v_so_branch_id IS NOT NULL
       AND v_branch_id IS NOT NULL
       AND v_so_branch_id <> v_branch_id THEN
      RETURN jsonb_build_object('success', false, 'error',
        'Sales order is in a different branch than the warehouse — pick a warehouse in the SO branch or transfer the order.');
    END IF;
  END IF;

  -- Iterate delivery items
  FOR v_item IN
    SELECT dni.id, dni.product_id, dni.description, dni.quantity_delivered,
           p.cost_price, p.track_inventory,
           p.inventory_account_id, p.cogs_account_id
      FROM delivery_note_items dni
 LEFT JOIN products p ON p.id = dni.product_id
     WHERE dni.delivery_note_id = p_dn_id
       AND dni.quantity_delivered > 0
  LOOP
    IF v_item.product_id IS NULL OR NOT COALESCE(v_item.track_inventory, true) THEN
      CONTINUE;
    END IF;

    v_unit_cost := COALESCE(v_item.cost_price, 0);

    INSERT INTO stock_movements (
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

  -- COGS GL: DR COGS / CR Inventory
  IF v_total_cogs > 0 THEN
    SELECT id INTO v_inventory_acct
      FROM accounts
     WHERE organization_id = v_org_id
       AND business_id = v_biz_id
       AND detail_type = 'inventory'
       AND is_active = true
     LIMIT 1;

    SELECT id INTO v_cogs_acct
      FROM accounts
     WHERE organization_id = v_org_id
       AND business_id = v_biz_id
       AND detail_type = 'cost_of_goods_sold'
       AND is_active = true
     LIMIT 1;

    IF v_inventory_acct IS NOT NULL AND v_cogs_acct IS NOT NULL THEN
      INSERT INTO journal_entries (
        organization_id, business_id, entry_date, reference, memo,
        source_type, source_id, status, created_by
      ) VALUES (
        v_org_id, v_biz_id, CURRENT_DATE,
        v_dn.delivery_number,
        'COGS for delivery ' || v_dn.delivery_number,
        'delivery', p_dn_id::text,
        'posted', p_user_id
      )
      RETURNING id INTO v_journal_id;

      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_amount, credit_amount, description)
      VALUES
        (v_journal_id, v_cogs_acct, v_total_cogs, 0, 'COGS — ' || v_dn.delivery_number),
        (v_journal_id, v_inventory_acct, 0, v_total_cogs, 'Inventory out — ' || v_dn.delivery_number);
    END IF;
  END IF;

  -- Mark delivered
  UPDATE delivery_notes
     SET status = 'delivered',
         delivered_at = now(),
         received_by = COALESCE(p_received_by, received_by)
   WHERE id = p_dn_id;

  RETURN jsonb_build_object(
    'success', true,
    'delivery_id', p_dn_id,
    'movements_created', v_movement_count,
    'total_cogs', v_total_cogs,
    'gl_posted', v_journal_id IS NOT NULL
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_delivery_atomic(uuid, uuid, text) TO authenticated;