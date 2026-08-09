CREATE OR REPLACE FUNCTION public.update_sales_order_atomic(p_so_id uuid, p_header jsonb, p_items jsonb, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_so       record;
  v_user     uuid := COALESCE(p_user_id, auth.uid());
  v_subtotal numeric := 0;
  v_tax      numeric := 0;
  v_discount numeric := COALESCE(NULLIF(p_header->>'discount_amount','')::numeric, 0);
  v_shipping numeric := COALESCE(NULLIF(p_header->>'shipping_amount','')::numeric, 0);
  v_total    numeric;
  v_keep     uuid[];
  v_bad      record;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sales order not found');
  END IF;
  IF NOT public.user_can_access_business(v_user, v_so.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(v_so.is_locked, false) THEN
    RETURN jsonb_build_object('success', false,
      'error', 'This order is locked because it has been invoiced. Issue a credit note instead.');
  END IF;
  IF v_so.status IN ('invoiced', 'cancelled', 'fulfilled') THEN
    RETURN jsonb_build_object('success', false,
      'error', format('A %s order cannot be edited', v_so.status));
  END IF;

  SELECT COALESCE(array_agg(NULLIF(i->>'id','')::uuid) FILTER (WHERE NULLIF(i->>'id','') IS NOT NULL), '{}')
    INTO v_keep
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) i;

  SELECT soi.id, soi.description INTO v_bad
    FROM public.sales_order_items soi
   WHERE soi.sales_order_id = p_so_id
     AND NOT (soi.id = ANY (v_keep))
     AND (COALESCE(soi.quantity_fulfilled, 0) > 0 OR COALESCE(soi.quantity_invoiced, 0) > 0)
   LIMIT 1;
  IF v_bad.id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false,
      'error', format('Line "%s" has already been delivered or invoiced and cannot be removed', v_bad.description));
  END IF;

  DELETE FROM public.sales_order_items
   WHERE sales_order_id = p_so_id
     AND NOT (id = ANY (v_keep));

  UPDATE public.sales_order_items soi
     SET product_id       = NULLIF(t.i->>'product_id','')::uuid,
         description      = COALESCE(t.i->>'description', soi.description),
         quantity         = COALESCE((t.i->>'quantity')::numeric, soi.quantity),
         unit_price       = COALESCE((t.i->>'unit_price')::numeric, soi.unit_price),
         tax_rate         = COALESCE((t.i->>'tax_rate')::numeric, 0),
         tax_amount       = COALESCE((t.i->>'tax_amount')::numeric, 0),
         discount_percent = COALESCE((t.i->>'discount_percent')::numeric, 0),
         line_total       = COALESCE((t.i->>'line_total')::numeric, 0),
         sort_order       = COALESCE((t.i->>'sort_order')::int, (t.ord - 1)::int),
         project_id       = NULLIF(t.i->>'project_id','')::uuid,
         packaging_id     = NULLIF(t.i->>'packaging_id','')::uuid,
         display_uom_id   = NULLIF(t.i->>'display_uom_id','')::uuid,
         display_quantity = NULLIF(t.i->>'display_quantity','')::numeric
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) WITH ORDINALITY AS t(i, ord)
   WHERE soi.id = NULLIF(t.i->>'id','')::uuid
     AND soi.sales_order_id = p_so_id;

  SELECT soi.id, soi.description INTO v_bad
    FROM public.sales_order_items soi
   WHERE soi.sales_order_id = p_so_id
     AND soi.quantity < GREATEST(COALESCE(soi.quantity_fulfilled, 0), COALESCE(soi.quantity_invoiced, 0))
   LIMIT 1;
  IF v_bad.id IS NOT NULL THEN
    RAISE EXCEPTION 'Line "%" cannot be reduced below the quantity already delivered or invoiced', v_bad.description
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.sales_order_items (
    sales_order_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order,
    project_id, packaging_id, display_uom_id, display_quantity
  )
  SELECT p_so_id,
         NULLIF(i->>'product_id','')::uuid,
         COALESCE(i->>'description',''),
         COALESCE((i->>'quantity')::numeric, 1),
         COALESCE((i->>'unit_price')::numeric, 0),
         COALESCE((i->>'tax_rate')::numeric, 0),
         COALESCE((i->>'tax_amount')::numeric, 0),
         COALESCE((i->>'discount_percent')::numeric, 0),
         COALESCE((i->>'line_total')::numeric, 0),
         COALESCE((i->>'sort_order')::int, (ord - 1)::int),
         NULLIF(i->>'project_id','')::uuid,
         NULLIF(i->>'packaging_id','')::uuid,
         NULLIF(i->>'display_uom_id','')::uuid,
         NULLIF(i->>'display_quantity','')::numeric
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) WITH ORDINALITY AS t(i, ord)
   WHERE NULLIF(i->>'id','') IS NULL;

  SELECT COALESCE(SUM(line_total), 0), COALESCE(SUM(tax_amount), 0)
    INTO v_subtotal, v_tax
    FROM public.sales_order_items WHERE sales_order_id = p_so_id;

  v_total := round(v_subtotal + v_tax - v_discount + v_shipping, 2);

  UPDATE public.sales_orders
     SET contact_id         = COALESCE(NULLIF(p_header->>'contact_id','')::uuid, contact_id),
         order_date         = COALESCE(NULLIF(p_header->>'order_date','')::date, order_date),
         expected_date      = NULLIF(p_header->>'expected_date','')::date,
         ship_to_contact_id = CASE WHEN p_header ? 'ship_to_contact_id'
                                   THEN NULLIF(p_header->>'ship_to_contact_id','')::uuid
                                   ELSE ship_to_contact_id END,
         shipping_address   = NULLIF(p_header->>'shipping_address',''),
         notes              = NULLIF(p_header->>'notes',''),
         terms              = NULLIF(p_header->>'terms',''),
         project_id         = NULLIF(p_header->>'project_id','')::uuid,
         salesperson_id     = COALESCE(NULLIF(p_header->>'salesperson_id','')::uuid, salesperson_id),
         payment_term_id    = COALESCE(NULLIF(p_header->>'payment_term_id','')::uuid, payment_term_id),
         subtotal           = round(v_subtotal, 2),
         tax_amount         = round(v_tax, 2),
         discount_amount    = round(v_discount, 2),
         shipping_amount    = round(v_shipping, 2),
         total              = v_total,
         updated_at         = now()
   WHERE id = p_so_id;

  RETURN jsonb_build_object(
    'success', true,
    'sales_order_id', p_so_id,
    'subtotal', round(v_subtotal, 2),
    'tax_amount', round(v_tax, 2),
    'total', v_total
  );
END $function$;