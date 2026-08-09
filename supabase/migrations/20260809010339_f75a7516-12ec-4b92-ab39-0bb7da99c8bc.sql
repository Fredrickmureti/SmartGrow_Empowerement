-- 1) Atomic sales-order edit that preserves the quantity ledger
CREATE OR REPLACE FUNCTION public.update_sales_order_atomic(
  p_so_id uuid,
  p_header jsonb,
  p_items jsonb,
  p_user_id uuid DEFAULT NULL
)
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

  -- lines the caller intends to keep (those carrying an id)
  SELECT COALESCE(array_agg(NULLIF(i->>'id','')::uuid) FILTER (WHERE NULLIF(i->>'id','') IS NOT NULL), '{}')
    INTO v_keep
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) i;

  -- refuse deleting a line that already has delivered or invoiced quantity
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

  -- update surviving lines in place (preserves the ledger and provenance links)
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

  -- a surviving line may not drop below what already happened
  SELECT soi.id, soi.description INTO v_bad
    FROM public.sales_order_items soi
   WHERE soi.sales_order_id = p_so_id
     AND soi.quantity < GREATEST(COALESCE(soi.quantity_fulfilled, 0), COALESCE(soi.quantity_invoiced, 0))
   LIMIT 1;
  IF v_bad.id IS NOT NULL THEN
    RAISE EXCEPTION 'Line "%" cannot be reduced below the quantity already delivered or invoiced', v_bad.description
      USING ERRCODE = '22023';
  END IF;

  -- insert genuinely new lines
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

  -- server-derived totals
  SELECT COALESCE(SUM(line_total), 0), COALESCE(SUM(tax_amount), 0)
    INTO v_subtotal, v_tax
    FROM public.sales_order_items WHERE sales_order_id = p_so_id;

  v_total := round(v_subtotal + v_tax - v_discount + v_shipping, 2);

  UPDATE public.sales_orders
     SET contact_id       = COALESCE(NULLIF(p_header->>'contact_id','')::uuid, contact_id),
         order_date       = COALESCE(NULLIF(p_header->>'order_date','')::date, order_date),
         expected_date    = NULLIF(p_header->>'expected_date','')::date,
         shipping_address = NULLIF(p_header->>'shipping_address',''),
         notes            = NULLIF(p_header->>'notes',''),
         terms            = NULLIF(p_header->>'terms',''),
         project_id       = NULLIF(p_header->>'project_id','')::uuid,
         salesperson_id   = COALESCE(NULLIF(p_header->>'salesperson_id','')::uuid, salesperson_id),
         payment_term_id  = COALESCE(NULLIF(p_header->>'payment_term_id','')::uuid, payment_term_id),
         subtotal         = round(v_subtotal, 2),
         tax_amount       = round(v_tax, 2),
         discount_amount  = round(v_discount, 2),
         shipping_amount  = round(v_shipping, 2),
         total            = v_total,
         updated_at       = now()
   WHERE id = p_so_id;

  RETURN jsonb_build_object(
    'success', true,
    'sales_order_id', p_so_id,
    'subtotal', round(v_subtotal, 2),
    'tax_amount', round(v_tax, 2),
    'total', v_total
  );
END $function$;

REVOKE ALL ON FUNCTION public.update_sales_order_atomic(uuid, jsonb, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_sales_order_atomic(uuid, jsonb, jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_sales_order_atomic(uuid, jsonb, jsonb, uuid) TO service_role;

-- 2) DB-owned approval transitions
CREATE OR REPLACE FUNCTION public.set_sales_order_approval_state_atomic(
  p_so_id uuid,
  p_action text,
  p_user_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_so     record;
  v_user   uuid := COALESCE(p_user_id, auth.uid());
  v_target text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN ('submit', 'approve', 'reject') THEN
    RAISE EXCEPTION 'Unknown approval action %', p_action USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sales order not found');
  END IF;
  IF NOT public.user_can_access_business(v_user, v_so.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  IF p_action = 'submit' THEN
    IF v_so.status <> 'draft' THEN
      RETURN jsonb_build_object('success', false,
        'error', format('Only a draft order can be submitted for approval (got %s)', v_so.status));
    END IF;
    v_target := 'pending_approval';
  ELSE
    IF v_so.status <> 'pending_approval' THEN
      RETURN jsonb_build_object('success', false,
        'error', format('Order is not awaiting approval (status %s)', v_so.status));
    END IF;
    v_target := CASE WHEN p_action = 'approve' THEN 'approved' ELSE 'rejected' END;
  END IF;

  UPDATE public.sales_orders
     SET status = v_target, updated_at = now()
   WHERE id = p_so_id;

  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id, action, entity_type, entity_id, changes
  ) VALUES (
    v_so.organization_id, v_so.business_id, v_user,
    'sales_order_' || p_action, 'sales_order', p_so_id,
    jsonb_build_object('from', v_so.status, 'to', v_target, 'notes', p_notes)
  );

  RETURN jsonb_build_object('success', true, 'status', v_target);
END $function$;

REVOKE ALL ON FUNCTION public.set_sales_order_approval_state_atomic(uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_sales_order_approval_state_atomic(uuid, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_sales_order_approval_state_atomic(uuid, text, uuid, text) TO service_role;