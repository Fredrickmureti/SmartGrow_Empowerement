-- =====================================================================
-- Phase 3a: FEFO resolver + atomic lot consumer
-- Standalone primitives. Downstream atomic RPCs adopt them per-call-site
-- in later focused migrations.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.resolve_fefo_lots(
  p_business_id  uuid,
  p_warehouse_id uuid,
  p_product_id   uuid,
  p_required_qty numeric
)
RETURNS TABLE (
  lot_id       uuid,
  lot_number   text,
  serial_number text,
  qty          numeric,
  expiry_date  date
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_total_available numeric;
BEGIN
  IF p_required_qty IS NULL OR p_required_qty <= 0 THEN
    RAISE EXCEPTION 'required_qty must be > 0' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT COALESCE(SUM(wsl.quantity - wsl.reserved_quantity), 0)
    INTO v_total_available
    FROM public.warehouse_stock_lots wsl
   WHERE wsl.business_id  = p_business_id
     AND wsl.warehouse_id = p_warehouse_id
     AND wsl.product_id   = p_product_id
     AND (wsl.quantity - wsl.reserved_quantity) > 0;

  IF v_total_available < p_required_qty THEN
    RAISE EXCEPTION
      'insufficient_lot_stock: need %, have % available across all lots',
      p_required_qty, v_total_available
      USING ERRCODE = 'insufficient_resources';
  END IF;

  RETURN QUERY
  WITH lots AS (
    SELECT
      wsl.lot_id,
      sl.lot_number,
      sl.serial_number,
      (wsl.quantity - wsl.reserved_quantity) AS available,
      sl.expiry_date,
      ROW_NUMBER() OVER (
        ORDER BY sl.expiry_date NULLS LAST, sl.created_at, wsl.lot_id
      ) AS rn
    FROM public.warehouse_stock_lots wsl
    JOIN public.stock_lots sl ON sl.id = wsl.lot_id
    WHERE wsl.business_id  = p_business_id
      AND wsl.warehouse_id = p_warehouse_id
      AND wsl.product_id   = p_product_id
      AND (wsl.quantity - wsl.reserved_quantity) > 0
  ),
  running AS (
    SELECT l.*,
           SUM(available) OVER (ORDER BY rn ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum,
           SUM(available) OVER (ORDER BY rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_cum
      FROM lots l
  )
  SELECT
    r.lot_id,
    r.lot_number,
    r.serial_number,
    LEAST(r.available, p_required_qty - COALESCE(r.prev_cum, 0))::numeric AS qty,
    r.expiry_date
  FROM running r
  WHERE COALESCE(r.prev_cum, 0) < p_required_qty
  ORDER BY r.rn;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_fefo_lots(uuid, uuid, uuid, numeric) TO authenticated;

COMMENT ON FUNCTION public.resolve_fefo_lots(uuid, uuid, uuid, numeric) IS
  'Returns the FEFO (first-expiring-first-out) allocation list for a given product+warehouse+required quantity. Lots with no expiry sort last. Reserved quantity is honoured.';

-- =====================================================================
-- consume_lots_atomic: write per-lot outbound movements in one txn
-- =====================================================================
CREATE OR REPLACE FUNCTION public.consume_lots_atomic(
  p_organization_id uuid,
  p_business_id     uuid,
  p_warehouse_id    uuid,
  p_branch_id       uuid,
  p_product_id      uuid,
  p_movement_type   text,
  p_reference_type  text,
  p_reference_id    uuid,
  p_user_id         uuid,
  p_notes           text,
  p_allocations     jsonb,  -- [{lot_number, serial_number?, qty, allocation_override?}]
  p_unit_cost       numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_alloc       jsonb;
  v_qty         numeric;
  v_total       numeric := 0;
  v_lot_number  text;
  v_serial      text;
  v_override    boolean;
  v_movement_id uuid;
  v_movement_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_allocations IS NULL OR jsonb_array_length(p_allocations) = 0 THEN
    RAISE EXCEPTION 'allocations array required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_movement_type NOT IN
     ('sale','delivery','pos_sale','transfer_out','scrap','adjustment_out','return_out','vendor_return') THEN
    RAISE EXCEPTION 'consume_lots_atomic only handles outbound movement types, got %', p_movement_type
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_lot_number := v_alloc->>'lot_number';
    v_serial     := v_alloc->>'serial_number';
    v_qty        := (v_alloc->>'qty')::numeric;
    v_override   := COALESCE((v_alloc->>'allocation_override')::boolean, false);

    IF v_lot_number IS NULL OR v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'each allocation needs lot_number and positive qty: %', v_alloc
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, movement_type, quantity, unit_cost,
      reference_type, reference_id, notes,
      lot_number, serial_number, created_by
    ) VALUES (
      p_organization_id, p_business_id, p_branch_id, p_warehouse_id,
      p_product_id, p_movement_type::stock_movement_type, v_qty,
      COALESCE(p_unit_cost, 0),
      p_reference_type, p_reference_id,
      COALESCE(p_notes, '') ||
        CASE WHEN v_override THEN ' [lot override]' ELSE '' END,
      v_lot_number, v_serial, p_user_id
    )
    RETURNING id INTO v_movement_id;

    v_movement_ids := v_movement_ids || v_movement_id;
    v_total := v_total + v_qty;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'movement_ids', to_jsonb(v_movement_ids),
    'total_qty', v_total,
    'lot_count', jsonb_array_length(p_allocations)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.consume_lots_atomic(uuid, uuid, uuid, uuid, uuid, text, text, uuid, uuid, text, jsonb, numeric) TO authenticated;

COMMENT ON FUNCTION public.consume_lots_atomic(uuid, uuid, uuid, uuid, uuid, text, text, uuid, uuid, text, jsonb, numeric) IS
  'Phase 3 (FEFO) consumer. Writes N stock_movements rows — one per lot allocation — inside a single transaction. The _maintain_warehouse_stock_lots trigger decrements warehouse_stock_lots.quantity per lot. Outbound types only.';