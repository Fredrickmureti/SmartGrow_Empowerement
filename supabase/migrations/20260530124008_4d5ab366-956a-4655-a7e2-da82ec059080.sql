-- =====================================================================
-- Phase 1: Per-base-unit cost scaling on goods receipt completion
-- Closes Gap A from the inventory audit.
-- =====================================================================

-- 1. Audit column on goods_receipt_items
ALTER TABLE public.goods_receipt_items
  ADD COLUMN IF NOT EXISTS unit_cost_basis text
    NOT NULL DEFAULT 'per_display_unit'
    CHECK (unit_cost_basis IN ('per_display_unit','per_base_unit'));

COMMENT ON COLUMN public.goods_receipt_items.unit_cost_basis IS
  'Records whether the source purchase price was per pack/display unit (default) or already per base unit. Drives downstream cost scaling in complete_goods_receipt_atomic.';

-- 2. Rewrite complete_goods_receipt_atomic with cost scaling
CREATE OR REPLACE FUNCTION public.complete_goods_receipt_atomic(p_grn_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_grn RECORD; v_po RECORD; v_item RECORD;
  v_warehouse_id uuid; v_branch_id uuid; v_org_id uuid; v_biz_id uuid;
  v_inventory_acct uuid; v_grni_acct uuid; v_journal_id uuid;
  v_total_cost numeric := 0; v_line_cost numeric; v_unit_cost numeric;
  v_movement_count int := 0; v_all_received boolean; v_any_received boolean := false;
  v_raw_cost numeric; v_poi_base_qty numeric; v_poi_display_qty numeric;
BEGIN
  SELECT id, organization_id, business_id, warehouse_id, branch_id,
         purchase_order_id, receipt_number, status
    INTO v_grn FROM goods_receipts WHERE id = p_grn_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Goods receipt not found'); END IF;
  IF v_grn.status = 'completed' THEN RETURN jsonb_build_object('success', false, 'error', 'Goods receipt already completed'); END IF;

  v_org_id := v_grn.organization_id; v_biz_id := v_grn.business_id; v_warehouse_id := v_grn.warehouse_id;
  IF v_warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Goods receipt has no warehouse — set warehouse_id before completing');
  END IF;

  SELECT business_id, branch_id INTO v_biz_id, v_branch_id FROM warehouses WHERE id = v_warehouse_id;
  IF v_biz_id IS NULL OR v_biz_id <> v_grn.business_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Warehouse does not belong to receipt company');
  END IF;

  SELECT id, po_number, status INTO v_po FROM purchase_orders WHERE id = v_grn.purchase_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Purchase order not found'); END IF;

  FOR v_item IN
    SELECT gri.id, gri.product_id, gri.purchase_order_item_id,
           gri.description, gri.quantity_received, gri.unit_cost_basis,
           gri.lot_number, gri.serial_number, gri.notes,
           poi.unit_price, poi.quantity AS po_quantity,
           poi.display_quantity AS poi_display_quantity,
           poi.quantity_received AS po_qty_already_received,
           p.cost_price, p.track_inventory, p.inventory_account_id
      FROM goods_receipt_items gri
 LEFT JOIN purchase_order_items poi ON poi.id = gri.purchase_order_item_id
 LEFT JOIN products p ON p.id = gri.product_id
     WHERE gri.goods_receipt_id = p_grn_id
  LOOP
    v_any_received := true;
    IF v_item.product_id IS NOT NULL AND COALESCE(v_item.track_inventory, true) THEN
      -- Raw cost as entered (per display/purchase unit, unless explicitly per_base_unit)
      v_raw_cost := COALESCE(v_item.unit_price, v_item.cost_price, 0);

      -- Per-base-unit cost derivation:
      --   per_base_cost = unit_price * display_quantity / quantity_in_base
      -- where poi.quantity is already normalised to base units by _uom_normalize_line.
      -- This collapses both packaging-based and convert_uom-based conversion paths
      -- into one expression: cost-per-pack ÷ pack-size-in-base-units.
      IF v_item.unit_cost_basis = 'per_base_unit' THEN
        v_unit_cost := v_raw_cost;
      ELSIF v_item.purchase_order_item_id IS NOT NULL
            AND COALESCE(v_item.poi_display_quantity, 0) > 0
            AND COALESCE(v_item.po_quantity, 0) > 0
            AND v_item.po_quantity <> v_item.poi_display_quantity THEN
        v_unit_cost := v_raw_cost * v_item.poi_display_quantity / v_item.po_quantity;
      ELSE
        v_unit_cost := v_raw_cost;
      END IF;

      INSERT INTO stock_movements (
        organization_id, business_id, branch_id, warehouse_id,
        product_id, movement_type, quantity, unit_cost,
        reference_type, reference_id, notes,
        lot_number, serial_number, created_by
      ) VALUES (
        v_org_id, v_biz_id, v_branch_id, v_warehouse_id,
        v_item.product_id, 'receipt', v_item.quantity_received, v_unit_cost,
        'goods_receipt', p_grn_id,
        'GRN ' || v_grn.receipt_number || COALESCE(' — ' || v_item.description, ''),
        v_item.lot_number, v_item.serial_number, p_user_id
      );
      v_movement_count := v_movement_count + 1;
      v_line_cost := v_item.quantity_received * v_unit_cost;
      v_total_cost := v_total_cost + v_line_cost;
    END IF;
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

  UPDATE goods_receipts SET status = 'completed', updated_at = now() WHERE id = p_grn_id;

  SELECT bool_and(COALESCE(quantity_received, 0) >= quantity) INTO v_all_received
    FROM purchase_order_items WHERE purchase_order_id = v_po.id;
  IF v_all_received THEN
    UPDATE purchase_orders SET status = 'received' WHERE id = v_po.id;
  ELSIF v_any_received THEN
    UPDATE purchase_orders SET status = 'partial_received' WHERE id = v_po.id;
  END IF;

  IF v_total_cost > 0 THEN
    SELECT id INTO v_inventory_acct FROM accounts
     WHERE organization_id = v_org_id AND business_id = v_biz_id
       AND detail_type = 'inventory' AND is_active = true LIMIT 1;

    SELECT id INTO v_grni_acct FROM accounts
     WHERE business_id = v_biz_id AND system_role = 'grni' LIMIT 1;

    IF v_inventory_acct IS NOT NULL AND v_grni_acct IS NOT NULL THEN
      INSERT INTO journal_entries (
        organization_id, business_id, branch_id, entry_date,
        reference_type, reference_id, description, status, created_by
      ) VALUES (
        v_org_id, v_biz_id, v_branch_id, current_date,
        'goods_receipt', p_grn_id,
        'GRN ' || v_grn.receipt_number || ' — Inventory receipt',
        'posted', p_user_id
      ) RETURNING id INTO v_journal_id;

      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
      VALUES
        (v_journal_id, v_inventory_acct, v_total_cost, 0, 'Inventory in (GRN ' || v_grn.receipt_number || ')'),
        (v_journal_id, v_grni_acct, 0, v_total_cost, 'GR/NI accrual (GRN ' || v_grn.receipt_number || ')');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'movement_count', v_movement_count,
    'total_cost', v_total_cost,
    'journal_id', v_journal_id
  );
END;
$function$;

-- 3. Reconciliation view: surfaces receipts whose recorded cost diverges
--    from the order line total. > 1¢ delta means either the historical
--    pre-fix bug applied, or someone manually edited a downstream row.
CREATE OR REPLACE VIEW public.goods_receipt_lines_with_suspect_cost AS
SELECT
  gri.id                                AS goods_receipt_item_id,
  gri.goods_receipt_id,
  gr.receipt_number,
  gri.product_id,
  p.name                                AS product_name,
  gri.quantity_received                 AS base_qty_received,
  poi.display_quantity                  AS po_display_qty,
  poi.quantity                          AS po_base_qty,
  poi.unit_price                        AS po_unit_price_per_display,
  sm.unit_cost                          AS ledger_unit_cost,
  sm.quantity * sm.unit_cost            AS ledger_line_value,
  poi.unit_price * COALESCE(poi.display_quantity, poi.quantity)
                                        AS expected_line_value,
  ABS(
    (sm.quantity * sm.unit_cost) -
    (poi.unit_price * COALESCE(poi.display_quantity, poi.quantity))
  )                                     AS variance,
  gr.created_at                         AS receipt_created_at
FROM public.goods_receipt_items gri
JOIN public.goods_receipts gr ON gr.id = gri.goods_receipt_id
LEFT JOIN public.purchase_order_items poi ON poi.id = gri.purchase_order_item_id
LEFT JOIN public.products p ON p.id = gri.product_id
LEFT JOIN LATERAL (
  SELECT unit_cost, quantity
    FROM public.stock_movements sm
   WHERE sm.reference_type = 'goods_receipt'
     AND sm.reference_id = gr.id
     AND sm.product_id = gri.product_id
   ORDER BY sm.created_at
   LIMIT 1
) sm ON true
WHERE gr.status = 'completed'
  AND sm.unit_cost IS NOT NULL
  AND poi.unit_price IS NOT NULL
  AND ABS(
        (sm.quantity * sm.unit_cost) -
        (poi.unit_price * COALESCE(poi.display_quantity, poi.quantity))
      ) > 0.01;

COMMENT ON VIEW public.goods_receipt_lines_with_suspect_cost IS
  'Phase 1 (UoM cost scaling) reconciliation view. Lists receipts where the value recorded in the inventory ledger does not match the purchase order line total. Pre-fix receipts with packaging unit_price divergence will appear here; finance reviews each row individually.';

GRANT SELECT ON public.goods_receipt_lines_with_suspect_cost TO authenticated;