-- ============================================================================
-- Purchase returns: stop reading goods_receipt_items.unit_cost_basis (a TEXT
-- basis label: 'per_display_unit' | 'per_base_unit') as if it were money.
--
-- One owner for "what did a base unit of this receipt line cost":
--   public.goods_receipt_line_base_unit_cost(gri_id)
-- The GRN stock poster (wms_apply_gr_stock) and the purchase-return engine
-- now both call it, so a receipt and its return can never disagree on cost.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.goods_receipt_line_base_unit_cost(_gri_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ROUND(
    CASE
      WHEN gri.unit_cost_basis = 'per_base_unit' THEN raw.cost
      WHEN gri.purchase_order_item_id IS NOT NULL
       AND COALESCE(poi.display_quantity, 0) > 0
       AND COALESCE(poi.quantity, 0) > 0
       AND poi.quantity <> poi.display_quantity
        THEN raw.cost * poi.display_quantity / poi.quantity
      ELSE raw.cost
    END, 6)
    FROM public.goods_receipt_items gri
    LEFT JOIN public.purchase_order_items poi ON poi.id = gri.purchase_order_item_id
    LEFT JOIN public.products p ON p.id = gri.product_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(poi.unit_price, p.cost_price, 0)::numeric AS cost
    ) raw
   WHERE gri.id = _gri_id;
$$;

COMMENT ON FUNCTION public.goods_receipt_line_base_unit_cost(uuid) IS
  'Canonical per-base-unit landed cost of a goods-receipt line (ADR 0024). The only place the per_display_unit -> per_base_unit scaling lives.';

-- ---------------------------------------------------------------------------
-- Returnable ledger: unit_cost now comes from the helper, not from a text cast.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purchase_return_returnable_lines(_goods_receipt_id uuid)
RETURNS TABLE(goods_receipt_item_id uuid, product_id uuid, description text,
              lot_number text, serial_number text, quantity_received numeric,
              quantity_returned numeric, quantity_returnable numeric,
              unit_cost numeric, packaging_id uuid, display_uom_id uuid,
              uom_snapshot text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT gi.id,
         gi.product_id,
         COALESCE(gi.description::text, p.name::text, 'Received item'),
         gi.lot_number::text,
         gi.serial_number::text,
         COALESCE(gi.quantity_received::numeric, 0),
         COALESCE(ret.qty::numeric, 0),
         GREATEST(COALESCE(gi.quantity_received::numeric, 0) - COALESCE(ret.qty::numeric, 0), 0::numeric),
         COALESCE(public.goods_receipt_line_base_unit_cost(gi.id), 0),
         gi.packaging_id,
         gi.display_uom_id,
         gi.uom_snapshot::text
    FROM public.goods_receipt_items gi
    JOIN public.goods_receipts gr ON gr.id = gi.goods_receipt_id
    LEFT JOIN public.products p ON p.id = gi.product_id
    LEFT JOIN LATERAL (
      SELECT SUM(ri.quantity) AS qty
        FROM public.purchase_return_items ri
        JOIN public.purchase_returns r ON r.id = ri.purchase_return_id
       WHERE ri.goods_receipt_item_id = gi.id
         AND r.status NOT IN ('rejected','cancelled')
    ) ret ON TRUE
   WHERE gi.goods_receipt_id = _goods_receipt_id
     AND public.user_can_access_business(auth.uid(), gr.business_id)
   ORDER BY gi.sort_order NULLS LAST, gi.created_at;
$$;

-- ---------------------------------------------------------------------------
-- GRN stock poster delegates the scaling rule instead of re-implementing it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_apply_gr_stock(_gr_id uuid, _actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_grn RECORD; v_item RECORD;
  v_movement_count int := 0; v_total_cost numeric := 0;
  v_unit_cost numeric; v_line_cost numeric;
  v_any_received boolean := false; v_all_received boolean;
BEGIN
  SELECT id, organization_id, business_id, branch_id, warehouse_id,
         purchase_order_id, receipt_number
    INTO v_grn FROM goods_receipts WHERE id = _gr_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Goods receipt not found'); END IF;

  FOR v_item IN
    SELECT gri.id, gri.product_id, gri.purchase_order_item_id,
           gri.description, gri.quantity_received,
           gri.lot_number, gri.serial_number,
           p.track_inventory
      FROM goods_receipt_items gri
 LEFT JOIN products p ON p.id = gri.product_id
     WHERE gri.goods_receipt_id = _gr_id
  LOOP
    v_any_received := true;
    IF v_item.product_id IS NOT NULL AND COALESCE(v_item.track_inventory, true) THEN
      -- ADR 0024 scaling lives in exactly one function.
      v_unit_cost := COALESCE(public.goods_receipt_line_base_unit_cost(v_item.id), 0);

      INSERT INTO stock_movements (
        organization_id, business_id, branch_id, warehouse_id,
        product_id, movement_type, quantity, unit_cost,
        reference_type, reference_id, notes,
        lot_number, serial_number, created_by
      ) VALUES (
        v_grn.organization_id, v_grn.business_id, v_grn.branch_id, v_grn.warehouse_id,
        v_item.product_id, 'receipt', v_item.quantity_received, v_unit_cost,
        'goods_receipt', _gr_id,
        'GRN ' || v_grn.receipt_number || COALESCE(' — ' || v_item.description, ''),
        v_item.lot_number, v_item.serial_number, _actor
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

  SELECT bool_and(COALESCE(quantity_received, 0) >= quantity) INTO v_all_received
    FROM purchase_order_items WHERE purchase_order_id = v_grn.purchase_order_id;
  IF v_all_received THEN
    UPDATE purchase_orders SET status = 'received' WHERE id = v_grn.purchase_order_id;
  ELSIF v_any_received THEN
    UPDATE purchase_orders SET status = 'partial_received' WHERE id = v_grn.purchase_order_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'movement_count', v_movement_count, 'total_cost', v_total_cost);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.goods_receipt_line_base_unit_cost(uuid) TO authenticated, service_role;