CREATE OR REPLACE FUNCTION public.create_delivery_note_atomic(p_payload jsonb, p_lines jsonb, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := (p_payload->>'organization_id')::uuid;
  v_biz uuid := (p_payload->>'business_id')::uuid;
  v_number text;
  v_id uuid;
BEGIN
  IF v_org IS NULL OR v_biz IS NULL THEN
    RAISE EXCEPTION 'organization_id and business_id are required'
      USING ERRCODE = '22023';
  END IF;

  v_number := public.get_next_delivery_number(v_org, v_biz);

  INSERT INTO public.delivery_notes (
    organization_id, business_id, branch_id, delivery_number, contact_id,
    delivery_date, status, sales_order_id, shipping_address, driver_name,
    vehicle_number, notes, auto_invoice_on_complete, created_by
  ) VALUES (
    v_org, v_biz, NULLIF(p_payload->>'branch_id','')::uuid, v_number,
    NULLIF(p_payload->>'contact_id','')::uuid,
    COALESCE(NULLIF(p_payload->>'delivery_date','')::date, CURRENT_DATE),
    'pending',
    NULLIF(p_payload->>'sales_order_id','')::uuid,
    NULLIF(p_payload->>'shipping_address',''),
    NULLIF(p_payload->>'driver_name',''),
    NULLIF(p_payload->>'vehicle_number',''),
    NULLIF(p_payload->>'notes',''),
    COALESCE((p_payload->>'auto_invoice_on_complete')::boolean, true),
    p_user_id
  )
  RETURNING id INTO v_id;

  INSERT INTO public.delivery_note_items (
    delivery_note_id, description, quantity_ordered, quantity_delivered,
    product_id, sales_order_item_id, unit_price, tax_rate, tax_amount,
    discount_percent, line_total, sort_order, lot_number, serial_number,
    lot_allocations, packaging_id, display_uom_id, display_quantity
  )
  SELECT
    v_id,
    COALESCE(l->>'description',''),
    COALESCE((l->>'quantity_ordered')::numeric, 0),
    COALESCE((l->>'quantity_delivered')::numeric, 0),
    NULLIF(l->>'product_id','')::uuid,
    NULLIF(l->>'sales_order_item_id','')::uuid,
    NULLIF(l->>'unit_price','')::numeric,
    NULLIF(l->>'tax_rate','')::numeric,
    NULLIF(l->>'tax_amount','')::numeric,
    COALESCE(NULLIF(l->>'discount_percent','')::numeric, 0),
    NULLIF(l->>'line_total','')::numeric,
    (ord - 1)::int,
    NULLIF(l->>'lot_number',''),
    NULLIF(l->>'serial_number',''),
    CASE WHEN l ? 'lot_allocations' THEN l->'lot_allocations' ELSE NULL END,
    NULLIF(l->>'packaging_id','')::uuid,
    NULLIF(l->>'display_uom_id','')::uuid,
    NULLIF(l->>'display_quantity','')::numeric
  FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb)) WITH ORDINALITY AS t(l, ord);

  RETURN jsonb_build_object('success', true, 'id', v_id, 'delivery_number', v_number);
END;
$$;

REVOKE ALL ON FUNCTION public.create_delivery_note_atomic(jsonb, jsonb, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.create_delivery_note_atomic(jsonb, jsonb, uuid) TO authenticated, service_role;