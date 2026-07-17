
-- 1. Reversal linkage on stock_movements
ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS reverses_movement_id uuid
    REFERENCES public.stock_movements(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS stock_movements_reverses_idx
  ON public.stock_movements(reverses_movement_id)
  WHERE reverses_movement_id IS NOT NULL;

-- 2. Extend movement_type CHECK to include 'landed_cost'
ALTER TABLE public.stock_movements
  DROP CONSTRAINT IF EXISTS stock_movements_movement_type_check;

ALTER TABLE public.stock_movements
  ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type = ANY (ARRAY[
    'purchase','sale','pos_sale','pos_return',
    'receipt','delivery','adjustment',
    'return_in','return_out','transfer',
    'opening','scrap','count','migration',
    'landed_cost'
  ]));

-- 3. reverse_stock_movement RPC
CREATE OR REPLACE FUNCTION public.reverse_stock_movement(
  p_movement_id uuid,
  p_reason text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src public.stock_movements%ROWTYPE;
  v_existing uuid;
  v_new_id uuid;
BEGIN
  SELECT * INTO v_src FROM public.stock_movements WHERE id = p_movement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stock_movement % not found', p_movement_id USING ERRCODE = 'P0002';
  END IF;

  IF v_src.reverses_movement_id IS NOT NULL THEN
    RAISE EXCEPTION 'cannot reverse a reversal movement %', p_movement_id USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_existing FROM public.stock_movements
   WHERE reverses_movement_id = p_movement_id LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'movement % already reversed by %', p_movement_id, v_existing USING ERRCODE = 'P0001';
  END IF;

  IF v_src.business_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
      AND uba.business_id = v_src.business_id
      AND uba.role IN ('owner','admin','accountant','staff')
  ) THEN
    RAISE EXCEPTION 'not authorized to reverse movement %', p_movement_id USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.stock_movements (
    organization_id, business_id, branch_id, warehouse_id,
    product_id, movement_type, quantity, unit_cost,
    reference_type, reference_id, notes,
    movement_date, created_by, reverses_movement_id,
    source_packaging_id, source_uom_id
  ) VALUES (
    v_src.organization_id, v_src.business_id, v_src.branch_id, v_src.warehouse_id,
    v_src.product_id, v_src.movement_type, -v_src.quantity, v_src.unit_cost,
    v_src.reference_type, v_src.reference_id,
    COALESCE('REVERSAL: ' || COALESCE(p_reason, 'no reason given'), v_src.notes),
    now(), auth.uid(), v_src.id,
    v_src.source_packaging_id, v_src.source_uom_id
  ) RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_stock_movement(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reverse_stock_movement(uuid, text) TO authenticated;

-- 4. post_landed_cost_bill RPC
CREATE OR REPLACE FUNCTION public.post_landed_cost_bill(
  p_bill_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill public.landed_cost_bills%ROWTYPE;
  v_alloc_total numeric(18,4);
  v_alloc RECORD;
  v_movement_id uuid;
BEGIN
  SELECT * INTO v_bill FROM public.landed_cost_bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'landed_cost_bill % not found', p_bill_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
      AND uba.business_id = v_bill.business_id
      AND uba.role IN ('owner','admin','accountant','staff')
  ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF v_bill.status <> 'allocated' THEN
    RAISE EXCEPTION 'bill % is % (must be allocated to post)', p_bill_id, v_bill.status USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(SUM(allocated_amount), 0) INTO v_alloc_total
    FROM public.landed_cost_allocations WHERE landed_cost_bill_id = p_bill_id;

  IF ROUND(v_alloc_total, 2) <> ROUND(v_bill.total_amount, 2) THEN
    RAISE EXCEPTION 'allocations (%) do not equal bill total (%)',
      v_alloc_total, v_bill.total_amount USING ERRCODE = 'P0001';
  END IF;

  FOR v_alloc IN
    SELECT lca.id, lca.goods_receipt_item_id, lca.allocated_amount,
           gri.product_id, gr.warehouse_id, gr.branch_id
      FROM public.landed_cost_allocations lca
      JOIN public.goods_receipt_items gri ON gri.id = lca.goods_receipt_item_id
      JOIN public.goods_receipts gr ON gr.id = lca.goods_receipt_id
     WHERE lca.landed_cost_bill_id = p_bill_id
       AND lca.posted_movement_id IS NULL
  LOOP
    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, movement_type, quantity, unit_cost,
      reference_type, reference_id, notes, movement_date, created_by
    ) VALUES (
      v_bill.organization_id, v_bill.business_id, v_alloc.branch_id, v_alloc.warehouse_id,
      v_alloc.product_id, 'landed_cost', 0, v_alloc.allocated_amount,
      'landed_cost_bill', p_bill_id,
      'Landed cost ' || v_bill.cost_type || ' allocated to GRN line',
      now(), auth.uid()
    ) RETURNING id INTO v_movement_id;

    UPDATE public.landed_cost_allocations
       SET posted_movement_id = v_movement_id
     WHERE id = v_alloc.id;
  END LOOP;

  UPDATE public.landed_cost_bills
     SET status = 'posted', posted_at = now(), posted_by = auth.uid()
   WHERE id = p_bill_id;

  RETURN p_bill_id;
END;
$$;

REVOKE ALL ON FUNCTION public.post_landed_cost_bill(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_landed_cost_bill(uuid) TO authenticated;

-- 5. reverse_landed_cost_bill RPC
CREATE OR REPLACE FUNCTION public.reverse_landed_cost_bill(
  p_bill_id uuid,
  p_reason text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill public.landed_cost_bills%ROWTYPE;
  v_alloc RECORD;
BEGIN
  SELECT * INTO v_bill FROM public.landed_cost_bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'landed_cost_bill % not found', p_bill_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
      AND uba.business_id = v_bill.business_id
      AND uba.role IN ('owner','admin','accountant','staff')
  ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF v_bill.status <> 'posted' THEN
    RAISE EXCEPTION 'bill % is % (must be posted to reverse)', p_bill_id, v_bill.status USING ERRCODE = 'P0001';
  END IF;

  FOR v_alloc IN
    SELECT id, posted_movement_id FROM public.landed_cost_allocations
     WHERE landed_cost_bill_id = p_bill_id AND posted_movement_id IS NOT NULL
  LOOP
    PERFORM public.reverse_stock_movement(v_alloc.posted_movement_id, COALESCE(p_reason, 'landed cost reversal'));
    UPDATE public.landed_cost_allocations
       SET posted_movement_id = NULL
     WHERE id = v_alloc.id;
  END LOOP;

  UPDATE public.landed_cost_bills
     SET status = 'reversed'
   WHERE id = p_bill_id;

  RETURN p_bill_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_landed_cost_bill(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reverse_landed_cost_bill(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.reverse_stock_movement(uuid, text) IS 'ADR 0078 §4 — insert negating movement, forbid double reversal.';
COMMENT ON FUNCTION public.post_landed_cost_bill(uuid) IS 'ADR 0077 — post landed-cost bill: one stock_movement per allocation, quantity 0, unit_cost = allocated_amount.';
COMMENT ON FUNCTION public.reverse_landed_cost_bill(uuid, text) IS 'ADR 0077 — reverse posted landed-cost bill by reversing each allocation''s movement.';
