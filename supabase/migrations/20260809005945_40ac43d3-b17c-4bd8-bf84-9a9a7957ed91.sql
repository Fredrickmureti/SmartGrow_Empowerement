-- 1) Extend the ledger view with in-transit / plannable quantities
CREATE OR REPLACE VIEW public.so_line_balances AS
 SELECT soi.id AS sales_order_item_id,
    soi.sales_order_id,
    so.organization_id,
    so.business_id,
    so.branch_id,
    so.so_number,
    so.status AS order_status,
    soi.product_id,
    soi.description,
    soi.quantity AS quantity_ordered,
    COALESCE(soi.quantity_fulfilled, 0::numeric) AS quantity_delivered,
    COALESCE(soi.quantity_invoiced, 0::numeric) AS quantity_invoiced,
    COALESCE(ret.qty, 0::numeric) AS quantity_returned,
    COALESCE(soi.quantity_cancelled, 0::numeric) AS quantity_cancelled,
    GREATEST(soi.quantity - COALESCE(soi.quantity_fulfilled, 0::numeric) - COALESCE(soi.quantity_cancelled, 0::numeric), 0::numeric) AS quantity_open_to_deliver,
    GREATEST(soi.quantity - COALESCE(soi.quantity_invoiced, 0::numeric) - COALESCE(soi.quantity_cancelled, 0::numeric), 0::numeric) AS quantity_open_to_invoice,
    soi.unit_price,
    soi.line_total,
    COALESCE(pend.qty, 0::numeric) AS quantity_on_open_deliveries,
    GREATEST(
      soi.quantity
        - COALESCE(soi.quantity_fulfilled, 0::numeric)
        - COALESCE(soi.quantity_cancelled, 0::numeric)
        - COALESCE(pend.qty, 0::numeric), 0::numeric) AS quantity_open_to_plan
   FROM sales_order_items soi
     JOIN sales_orders so ON so.id = soi.sales_order_id
     LEFT JOIN LATERAL ( SELECT COALESCE(sum(dni.quantity_delivered), 0::numeric) AS qty
           FROM delivery_note_items dni
             JOIN delivery_notes dn ON dn.id = dni.delivery_note_id
          WHERE dni.sales_order_item_id = soi.id AND COALESCE(dn.is_return, false) = true AND (dn.status = ANY (ARRAY['returned'::text, 'delivered'::text, 'partial'::text]))) ret ON true
     LEFT JOIN LATERAL ( SELECT COALESCE(sum(dni.quantity_delivered), 0::numeric) AS qty
           FROM delivery_note_items dni
             JOIN delivery_notes dn ON dn.id = dni.delivery_note_id
          WHERE dni.sales_order_item_id = soi.id
            AND COALESCE(dn.is_return, false) = false
            AND dn.status = ANY (ARRAY['pending'::text, 'ready_to_dispatch'::text, 'dispatched'::text, 'in_transit'::text])) pend ON true;

GRANT SELECT ON public.so_line_balances TO authenticated;
GRANT SELECT ON public.so_line_balances TO service_role;

-- 2) Single server-side delivery-note creation engine for sales orders
CREATE OR REPLACE FUNCTION public.create_delivery_from_sales_order_atomic(
  p_so_id uuid,
  p_user_id uuid,
  p_line_qtys jsonb DEFAULT NULL,
  p_delivery_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_so record;
  v_dn_id uuid;
  v_number text;
  v_rows int := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sales order not found');
  END IF;

  IF NOT public.user_can_access_business(COALESCE(p_user_id, auth.uid()), v_so.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  IF v_so.status NOT IN ('confirmed', 'processing', 'partial') THEN
    RETURN jsonb_build_object('success', false,
      'error', format('Cannot create a delivery for a %s order', v_so.status));
  END IF;

  SELECT public.get_next_delivery_number(v_so.organization_id) INTO v_number;

  INSERT INTO public.delivery_notes (
    organization_id, business_id, branch_id, contact_id, delivery_number,
    delivery_date, status, sales_order_id, shipping_address, notes, created_by
  ) VALUES (
    v_so.organization_id, v_so.business_id, v_so.branch_id, v_so.contact_id, v_number,
    COALESCE(p_delivery_date, CURRENT_DATE), 'pending', p_so_id,
    v_so.shipping_address, v_so.notes, COALESCE(p_user_id, auth.uid())
  ) RETURNING id INTO v_dn_id;

  INSERT INTO public.delivery_note_items (
    delivery_note_id, product_id, sales_order_item_id, description,
    quantity_ordered, quantity_delivered, sort_order
  )
  SELECT v_dn_id, b.product_id, b.sales_order_item_id, b.description,
         b.quantity_ordered, q.qty, ROW_NUMBER() OVER (ORDER BY b.sales_order_item_id)
    FROM public.so_line_balances b
    CROSS JOIN LATERAL (
      SELECT LEAST(
               b.quantity_open_to_plan,
               COALESCE((p_line_qtys->>(b.sales_order_item_id::text))::numeric,
                        b.quantity_open_to_plan)
             ) AS qty
    ) q
   WHERE b.sales_order_id = p_so_id
     AND q.qty > 0;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RAISE EXCEPTION 'No remaining quantity to deliver on this order';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'delivery_note_id', v_dn_id,
    'delivery_number', v_number,
    'line_count', v_rows
  );
END $function$;

REVOKE ALL ON FUNCTION public.create_delivery_from_sales_order_atomic(uuid, uuid, jsonb, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_delivery_from_sales_order_atomic(uuid, uuid, jsonb, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_delivery_from_sales_order_atomic(uuid, uuid, jsonb, date) TO service_role;

-- 3) Backorders become derived, not hand-maintained
CREATE OR REPLACE VIEW public.so_backorder_lines AS
  SELECT b.sales_order_item_id,
         b.sales_order_id,
         b.organization_id,
         b.business_id,
         b.branch_id,
         b.so_number,
         b.order_status,
         b.product_id,
         b.description,
         b.quantity_ordered,
         b.quantity_delivered,
         b.quantity_on_open_deliveries,
         b.quantity_open_to_deliver AS quantity_backordered,
         so.order_date,
         so.contact_id
    FROM public.so_line_balances b
    JOIN public.sales_orders so ON so.id = b.sales_order_id
   WHERE b.order_status IN ('confirmed', 'processing', 'partial')
     AND b.quantity_open_to_deliver > 0;

GRANT SELECT ON public.so_backorder_lines TO authenticated;
GRANT SELECT ON public.so_backorder_lines TO service_role;

-- legacy hand-maintained table is read-only from the app from now on
REVOKE INSERT, UPDATE, DELETE ON public.backorders FROM authenticated;