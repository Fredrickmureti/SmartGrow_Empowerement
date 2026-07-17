
-- ============================================================
-- Priority C — allocate_landed_cost_bill
-- Fans a landed cost bill total across selected GRN lines by
-- allocation_basis. Returns count of allocation rows written.
-- ============================================================
CREATE OR REPLACE FUNCTION public.allocate_landed_cost_bill(
  p_bill_id uuid,
  p_goods_receipt_ids uuid[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_bill public.landed_cost_bills%ROWTYPE;
  v_uid uuid := auth.uid();
  v_basis_sum numeric(18,4) := 0;
  v_written integer := 0;
  v_remaining numeric(18,4);
  v_running numeric(18,4) := 0;
  v_row RECORD;
  v_alloc numeric(18,4);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_bill FROM public.landed_cost_bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'landed_cost_bill % not found', p_bill_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = v_uid
      AND uba.business_id = v_bill.business_id
      AND uba.role IN ('owner','admin','accountant','staff')
  ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF v_bill.status <> 'draft' THEN
    RAISE EXCEPTION 'bill % is % (must be draft to allocate)', p_bill_id, v_bill.status USING ERRCODE = 'P0001';
  END IF;

  IF v_bill.allocation_basis = 'manual' THEN
    RAISE EXCEPTION 'allocation_basis=manual: caller must insert allocation rows directly, not via allocate_landed_cost_bill' USING ERRCODE = 'P0001';
  END IF;

  IF v_bill.allocation_basis NOT IN ('quantity','value') THEN
    RAISE EXCEPTION 'allocation_basis % is not yet supported by allocate_landed_cost_bill (use quantity, value, or manual)', v_bill.allocation_basis USING ERRCODE = 'P0001';
  END IF;

  -- Clear any leftover draft-phase allocations so re-runs are idempotent.
  DELETE FROM public.landed_cost_allocations
   WHERE landed_cost_bill_id = p_bill_id
     AND posted_movement_id IS NULL;

  -- Collect target GRN lines into a temp table so we can iterate twice
  -- (once for basis sum, once for allocation).
  CREATE TEMP TABLE tmp_lc_lines (
    goods_receipt_id uuid NOT NULL,
    goods_receipt_item_id uuid NOT NULL,
    product_id uuid,
    basis_value numeric(18,4) NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO tmp_lc_lines (goods_receipt_id, goods_receipt_item_id, product_id, basis_value)
  SELECT
    gri.goods_receipt_id,
    gri.id,
    gri.product_id,
    CASE v_bill.allocation_basis
      WHEN 'quantity' THEN COALESCE(gri.quantity_received, 0)
      WHEN 'value'    THEN COALESCE(gri.quantity_received, 0) * COALESCE(poi.unit_price, 0)
    END
  FROM public.goods_receipt_items gri
  JOIN public.goods_receipts gr ON gr.id = gri.goods_receipt_id
  LEFT JOIN public.purchase_order_items poi ON poi.id = gri.purchase_order_item_id
  WHERE gr.business_id = v_bill.business_id
    AND (
      p_goods_receipt_ids IS NULL
      OR gri.goods_receipt_id = ANY(p_goods_receipt_ids)
    )
    AND COALESCE(gri.quantity_received, 0) > 0;

  SELECT COALESCE(SUM(basis_value), 0) INTO v_basis_sum FROM tmp_lc_lines;

  IF v_basis_sum <= 0 THEN
    RAISE EXCEPTION 'no GRN lines with positive % basis to allocate against', v_bill.allocation_basis USING ERRCODE = 'P0001';
  END IF;

  v_remaining := v_bill.total_amount;

  -- Iterate ordered so the last row absorbs rounding drift.
  FOR v_row IN
    SELECT * FROM tmp_lc_lines ORDER BY goods_receipt_id, goods_receipt_item_id
  LOOP
    v_alloc := ROUND(v_bill.total_amount * v_row.basis_value / v_basis_sum, 2);
    v_running := v_running + v_alloc;
    v_written := v_written + 1;

    INSERT INTO public.landed_cost_allocations (
      organization_id, business_id, landed_cost_bill_id,
      goods_receipt_id, goods_receipt_item_id, product_id,
      basis_value, allocation_ratio, allocated_amount
    ) VALUES (
      v_bill.organization_id, v_bill.business_id, p_bill_id,
      v_row.goods_receipt_id, v_row.goods_receipt_item_id, v_row.product_id,
      v_row.basis_value,
      v_row.basis_value / v_basis_sum,
      v_alloc
    );
  END LOOP;

  -- Push any rounding delta onto the last allocation so
  -- SUM(allocated_amount) = total_amount exactly (post_landed_cost_bill
  -- rejects sums that don't tie).
  IF v_running <> v_bill.total_amount THEN
    UPDATE public.landed_cost_allocations
       SET allocated_amount = allocated_amount + (v_bill.total_amount - v_running)
     WHERE id = (
       SELECT id FROM public.landed_cost_allocations
        WHERE landed_cost_bill_id = p_bill_id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
     );
  END IF;

  UPDATE public.landed_cost_bills
     SET status = 'allocated', updated_at = now()
   WHERE id = p_bill_id;

  RETURN v_written;
END;
$function$;

REVOKE ALL ON FUNCTION public.allocate_landed_cost_bill(uuid, uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION public.allocate_landed_cost_bill(uuid, uuid[]) TO authenticated;

-- ============================================================
-- Priority D — match_bill_to_grn
-- For every bill line with a purchase_order_item_id, insert a
-- bill_grn_matches row against the corresponding GRN line(s) with
-- unit_cost_variance = bill_unit_price - po_unit_price.
-- Idempotent via UNIQUE(bill_item_id, goods_receipt_item_id).
-- Returns count of match rows inserted this call.
-- ============================================================
CREATE OR REPLACE FUNCTION public.match_bill_to_grn(p_bill_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_bill public.bills%ROWTYPE;
  v_uid uuid := auth.uid();
  v_inserted integer := 0;
  v_row RECORD;
  v_matched numeric(18,4);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_bill FROM public.bills WHERE id = p_bill_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill % not found', p_bill_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = v_uid
      AND uba.business_id = v_bill.business_id
      AND uba.role IN ('owner','admin','accountant','staff')
  ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  FOR v_row IN
    SELECT
      bi.id             AS bill_item_id,
      bi.purchase_order_item_id,
      bi.quantity       AS bill_qty,
      bi.unit_price     AS bill_unit_price,
      gri.id            AS goods_receipt_item_id,
      gri.goods_receipt_id,
      gri.quantity_received,
      poi.unit_price    AS po_unit_price
    FROM public.bill_items bi
    JOIN public.purchase_order_items poi ON poi.id = bi.purchase_order_item_id
    JOIN public.goods_receipt_items gri
         ON gri.purchase_order_item_id = bi.purchase_order_item_id
    WHERE bi.bill_id = p_bill_id
      AND bi.purchase_order_item_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.bill_grn_matches m
        WHERE m.bill_item_id = bi.id
          AND m.goods_receipt_item_id = gri.id
      )
  LOOP
    v_matched := LEAST(
      COALESCE(v_row.bill_qty, 0),
      COALESCE(v_row.quantity_received, 0)
    );

    INSERT INTO public.bill_grn_matches (
      organization_id, business_id, bill_id, bill_item_id,
      goods_receipt_id, goods_receipt_item_id,
      matched_quantity, unit_cost_variance, created_by
    ) VALUES (
      v_bill.organization_id, v_bill.business_id, p_bill_id, v_row.bill_item_id,
      v_row.goods_receipt_id, v_row.goods_receipt_item_id,
      v_matched,
      COALESCE(v_row.bill_unit_price, 0) - COALESCE(v_row.po_unit_price, 0),
      v_uid
    )
    ON CONFLICT (bill_item_id, goods_receipt_item_id) DO NOTHING;

    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN v_inserted;
END;
$function$;

REVOKE ALL ON FUNCTION public.match_bill_to_grn(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.match_bill_to_grn(uuid) TO authenticated;
