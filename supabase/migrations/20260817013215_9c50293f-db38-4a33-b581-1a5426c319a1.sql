-- INV-SIM Repair #6: consume_lots_atomic cast movement_type to a
-- non-existent enum `stock_movement_type` (the column is text), so the FEFO
-- consumption primitive from ADR 0025 raised 42704 on every call — killing
-- every lot-tracked outbound posting, including physical-count variance
-- posting for lot-tracked products. Cast removed.
CREATE OR REPLACE FUNCTION public.consume_lots_atomic(
  p_organization_id uuid, p_business_id uuid, p_warehouse_id uuid,
  p_branch_id uuid, p_product_id uuid, p_movement_type text,
  p_reference_type text, p_reference_id uuid, p_user_id uuid,
  p_notes text, p_allocations jsonb, p_unit_cost numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_alloc jsonb; v_qty numeric; v_total numeric := 0;
  v_lot text; v_serial text; v_override boolean;
  v_mid uuid; v_ids uuid[] := ARRAY[]::uuid[];
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
    v_lot      := v_alloc->>'lot_number';
    v_serial   := v_alloc->>'serial_number';
    v_qty      := (v_alloc->>'qty')::numeric;
    v_override := COALESCE((v_alloc->>'allocation_override')::boolean, false);

    IF v_lot IS NULL OR v_qty IS NULL OR v_qty <= 0 THEN
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
      p_product_id, p_movement_type, -v_qty,   -- negative for outbound
      COALESCE(p_unit_cost, 0),
      p_reference_type, p_reference_id,
      COALESCE(p_notes, '') || CASE WHEN v_override THEN ' [lot override]' ELSE '' END,
      v_lot, v_serial, p_user_id
    ) RETURNING id INTO v_mid;

    v_ids   := v_ids || v_mid;
    v_total := v_total + v_qty;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'movement_ids', to_jsonb(v_ids),
    'total_qty', v_total,
    'lot_count', jsonb_array_length(p_allocations)
  );
END;
$function$;