-- ============================================================================
-- Sales Phase 6b — warehouse is a first-class Sales decision
-- ============================================================================

-- 6b.1 persistence -----------------------------------------------------------
ALTER TABLE public.sales_orders   ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES public.warehouses(id);
ALTER TABLE public.invoices       ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES public.warehouses(id);
ALTER TABLE public.delivery_notes ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES public.warehouses(id);

COMMENT ON COLUMN public.sales_orders.warehouse_id IS
  'Stock location this order is committed against. Resolved by resolve_sales_warehouse(); reservations are taken here.';
COMMENT ON COLUMN public.invoices.warehouse_id IS
  'Stock location this invoice releases stock from. Resolved by resolve_sales_warehouse().';
COMMENT ON COLUMN public.delivery_notes.warehouse_id IS
  'Stock location goods ship from. Resolved by resolve_sales_warehouse(); consumed by complete_delivery_atomic.';

CREATE INDEX IF NOT EXISTS idx_sales_orders_warehouse   ON public.sales_orders(warehouse_id)   WHERE warehouse_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_warehouse       ON public.invoices(warehouse_id)       WHERE warehouse_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_notes_warehouse ON public.delivery_notes(warehouse_id) WHERE warehouse_id IS NOT NULL;

-- 6b.2 one resolver ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_sales_warehouse(
  p_organization_id uuid,
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL,
  p_requested_warehouse_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF p_organization_id IS NULL OR p_business_id IS NULL THEN
    RAISE EXCEPTION 'resolve_sales_warehouse: organization_id and business_id are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_requested_warehouse_id IS NOT NULL THEN
    SELECT w.id INTO v_id
      FROM public.warehouses w
     WHERE w.id = p_requested_warehouse_id
       AND w.organization_id = p_organization_id
       AND w.business_id = p_business_id
       AND w.is_active = true
       AND COALESCE(w.is_in_transit, false) = false
       AND (w.branch_id IS NULL OR p_branch_id IS NULL OR w.branch_id = p_branch_id);

    IF v_id IS NULL THEN
      RAISE EXCEPTION
        'Warehouse % is not a usable stock location for this business/branch (inactive, in-transit, or belongs elsewhere).',
        p_requested_warehouse_id USING ERRCODE = '22023';
    END IF;
    RETURN v_id;
  END IF;

  SELECT w.id INTO v_id
    FROM public.warehouses w
   WHERE w.organization_id = p_organization_id
     AND w.business_id = p_business_id
     AND w.is_active = true
     AND COALESCE(w.is_in_transit, false) = false
     AND COALESCE(w.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(p_branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
   ORDER BY w.is_default DESC NULLS LAST, w.created_at ASC
   LIMIT 1;

  IF v_id IS NULL THEN
    RAISE EXCEPTION
      'No active warehouse exists for this branch — create one (or mark one as default) before committing stock.'
      USING ERRCODE = '22023';
  END IF;

  RETURN v_id;
END;
$function$;

COMMENT ON FUNCTION public.resolve_sales_warehouse(uuid, uuid, uuid, uuid) IS
  'Sales Phase 6b: the ONLY place a Sales document chooses a stock location. Fail-closed.';

REVOKE ALL ON FUNCTION public.resolve_sales_warehouse(uuid, uuid, uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_sales_warehouse(uuid, uuid, uuid, uuid) TO authenticated, service_role;

-- 6b.3 creation stamps it ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_invoice_atomic(
  p_header jsonb, p_items jsonb, p_user_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org        uuid := NULLIF(p_header->>'organization_id','')::uuid;
  v_business   uuid := NULLIF(p_header->>'business_id','')::uuid;
  v_branch     uuid := NULLIF(p_header->>'branch_id','')::uuid;
  v_user       uuid := COALESCE(p_user_id, auth.uid());
  v_currency   text;
  v_issue_date date := COALESCE(NULLIF(p_header->>'issue_date','')::date, CURRENT_DATE);
  v_due_date   date;
  v_number     text;
  v_invoice_id uuid;
  v_warehouse  uuid;
  v_subtotal   numeric := 0;
  v_tax        numeric := 0;
  v_discount   numeric := COALESCE(NULLIF(p_header->>'discount_amount','')::numeric, 0);
  v_total      numeric;
  v_rate       numeric;
  v_lines      jsonb := '[]'::jsonb;
  v_item       jsonb;
  v_ord        int := 0;
  v_display    numeric;
  v_res        jsonb;
  v_base       numeric;
  v_claimed    numeric;
  v_unit_price numeric;
  v_disc_pct   numeric;
  v_tax_rate   numeric;
  v_line_total numeric;
  v_tax_amount numeric;
  v_existing   jsonb;
  v_result     jsonb;
  v_tracked    boolean;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR v_business IS NULL THEN
    RAISE EXCEPTION 'organization_id and business_id are required' USING ERRCODE = '22023';
  END IF;
  IF NOT public.user_can_access_business(v_user, v_business) THEN
    RAISE EXCEPTION 'Access denied for business %', v_business USING ERRCODE = '42501';
  END IF;

  IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
    SELECT response INTO v_existing
      FROM public.sales_document_idempotency
     WHERE organization_id = v_org
       AND document_type = 'invoice'
       AND idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN v_existing || jsonb_build_object('idempotent_replay', true);
    END IF;
  END IF;

  SELECT COALESCE(NULLIF(p_header->>'currency',''), b.base_currency, 'USD')
    INTO v_currency
    FROM public.businesses b WHERE b.id = v_business;

  v_due_date := COALESCE(NULLIF(p_header->>'due_date','')::date, v_issue_date);

  -- Phase 6b: an invoice that will move stock records WHERE it moves it.
  SELECT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) AS t(i)
      JOIN public.products p ON p.id = NULLIF(i->>'product_id','')::uuid
     WHERE COALESCE(p.track_inventory, false) = true
  ) INTO v_tracked;

  IF NULLIF(p_header->>'warehouse_id','') IS NOT NULL OR v_tracked THEN
    v_warehouse := public.resolve_sales_warehouse(
      v_org, v_business, v_branch, NULLIF(p_header->>'warehouse_id','')::uuid);
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    v_ord := v_ord + 1;
    v_display := COALESCE(
      NULLIF(v_item->>'display_quantity','')::numeric,
      NULLIF(v_item->>'quantity','')::numeric,
      1);
    IF v_display <= 0 THEN
      RAISE EXCEPTION 'line %: quantity must be greater than zero', v_ord USING ERRCODE = '22023';
    END IF;

    v_res := public.resolve_line_base_quantity(
      v_business,
      NULLIF(v_item->>'product_id','')::uuid,
      v_display,
      NULLIF(v_item->>'display_uom_id','')::uuid,
      NULLIF(v_item->>'packaging_id','')::uuid);
    v_base := (v_res->>'base_quantity')::numeric;

    v_claimed := NULLIF(v_item->>'quantity','')::numeric;
    IF v_claimed IS NOT NULL AND abs(v_claimed - v_base) > 0.0001 THEN
      RAISE EXCEPTION
        'line %: client base quantity % disagrees with the resolved base quantity % (display %)',
        v_ord, v_claimed, v_base, v_display USING ERRCODE = '22023';
    END IF;

    v_unit_price := COALESCE(NULLIF(v_item->>'unit_price','')::numeric, 0);
    v_disc_pct   := COALESCE(NULLIF(v_item->>'discount_percent','')::numeric, 0);
    v_tax_rate   := COALESCE(NULLIF(v_item->>'tax_rate','')::numeric, 0);
    v_line_total := round(v_display * v_unit_price * (1 - v_disc_pct / 100.0), 2);
    v_tax_amount := round(v_line_total * v_tax_rate / 100.0, 2);

    v_subtotal := v_subtotal + v_line_total;
    v_tax      := v_tax + v_tax_amount;

    v_lines := v_lines || jsonb_build_object(
      'product_id', NULLIF(v_item->>'product_id',''),
      'description', COALESCE(v_item->>'description',''),
      'quantity', v_base,
      'display_quantity', v_display,
      'display_uom_id', v_res->>'display_uom_id',
      'packaging_id', v_res->>'packaging_id',
      'uom_snapshot', v_res->>'uom_snapshot',
      'unit_price', v_unit_price,
      'discount_percent', v_disc_pct,
      'tax_rate', v_tax_rate,
      'tax_amount', v_tax_amount,
      'line_total', v_line_total,
      'sort_order', COALESCE(NULLIF(v_item->>'sort_order','')::int, v_ord - 1),
      'project_id', NULLIF(v_item->>'project_id',''),
      'task_id', NULLIF(v_item->>'task_id',''),
      'lot_number', NULLIF(v_item->>'lot_number',''),
      'serial_number', NULLIF(v_item->>'serial_number','')
    );
  END LOOP;

  v_total := round(v_subtotal + v_tax - v_discount, 2);
  v_rate  := public.resolve_sales_exchange_rate(v_org, v_business, v_currency, v_issue_date);
  v_number := public.get_next_invoice_number(v_org, v_business);

  INSERT INTO public.invoices (
    organization_id, business_id, branch_id, warehouse_id, invoice_number, contact_id,
    issue_date, due_date, status, currency, exchange_rate,
    subtotal, tax_amount, discount_amount, total,
    notes, terms, created_by, salesperson_id, payment_term_id,
    project_id, source_estimate_id, source_sales_order_id, source_proforma_invoice_id
  ) VALUES (
    v_org, v_business, v_branch, v_warehouse, v_number,
    NULLIF(p_header->>'contact_id','')::uuid,
    v_issue_date, v_due_date,
    'draft', v_currency, v_rate,
    round(v_subtotal, 2), round(v_tax, 2), round(v_discount, 2), v_total,
    NULLIF(p_header->>'notes',''),
    NULLIF(p_header->>'terms',''),
    v_user,
    COALESCE(NULLIF(p_header->>'salesperson_id','')::uuid, v_user),
    NULLIF(p_header->>'payment_term_id','')::uuid,
    NULLIF(p_header->>'project_id','')::uuid,
    NULLIF(p_header->>'source_estimate_id','')::uuid,
    NULLIF(p_header->>'source_sales_order_id','')::uuid,
    NULLIF(p_header->>'source_proforma_invoice_id','')::uuid
  )
  RETURNING id INTO v_invoice_id;

  INSERT INTO public.invoice_items (
    invoice_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order,
    project_id, task_id, packaging_id, display_uom_id, display_quantity, uom_snapshot,
    lot_number, serial_number
  )
  SELECT
    v_invoice_id,
    NULLIF(i->>'product_id','')::uuid,
    i->>'description',
    (i->>'quantity')::numeric,
    (i->>'unit_price')::numeric,
    (i->>'tax_rate')::numeric,
    (i->>'tax_amount')::numeric,
    (i->>'discount_percent')::numeric,
    (i->>'line_total')::numeric,
    (i->>'sort_order')::int,
    NULLIF(i->>'project_id','')::uuid,
    NULLIF(i->>'task_id','')::uuid,
    NULLIF(i->>'packaging_id','')::uuid,
    NULLIF(i->>'display_uom_id','')::uuid,
    (i->>'display_quantity')::numeric,
    NULLIF(i->>'uom_snapshot',''),
    NULLIF(i->>'lot_number',''),
    NULLIF(i->>'serial_number','')
  FROM jsonb_array_elements(v_lines) AS t(i);

  v_result := jsonb_build_object(
    'success', true,
    'invoice_id', v_invoice_id,
    'invoice_number', v_number,
    'warehouse_id', v_warehouse,
    'subtotal', round(v_subtotal, 2),
    'tax_amount', round(v_tax, 2),
    'discount_amount', round(v_discount, 2),
    'total', v_total,
    'exchange_rate', v_rate,
    'item_count', v_ord
  );

  IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
    INSERT INTO public.sales_document_idempotency (
      organization_id, business_id, document_type, idempotency_key,
      document_id, response, created_by
    ) VALUES (
      v_org, v_business, 'invoice', p_idempotency_key,
      v_invoice_id, v_result, v_user
    )
    ON CONFLICT (organization_id, document_type, idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_sales_order_atomic(
  p_header jsonb, p_items jsonb, p_user_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org        uuid := NULLIF(p_header->>'organization_id','')::uuid;
  v_business   uuid := NULLIF(p_header->>'business_id','')::uuid;
  v_branch     uuid := NULLIF(p_header->>'branch_id','')::uuid;
  v_user       uuid := COALESCE(p_user_id, auth.uid());
  v_status     text := COALESCE(NULLIF(p_header->>'status',''), 'draft');
  v_currency   text;
  v_order_date date := COALESCE(NULLIF(p_header->>'order_date','')::date, CURRENT_DATE);
  v_so_number  text;
  v_so_id      uuid;
  v_warehouse  uuid;
  v_tracked    boolean;
  v_subtotal   numeric := 0;
  v_tax        numeric := 0;
  v_discount   numeric := COALESCE(NULLIF(p_header->>'discount_amount','')::numeric, 0);
  v_shipping   numeric := COALESCE(NULLIF(p_header->>'shipping_amount','')::numeric, 0);
  v_total      numeric;
  v_rate       numeric;
  v_item_count int;
  v_lines      jsonb := '[]'::jsonb;
  v_item       jsonb;
  v_ord        int := 0;
  v_display    numeric;
  v_res        jsonb;
  v_base       numeric;
  v_claimed    numeric;
  v_unit_price numeric;
  v_disc_pct   numeric;
  v_tax_rate   numeric;
  v_line_total numeric;
  v_tax_amount numeric;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR v_business IS NULL THEN
    RAISE EXCEPTION 'organization_id and business_id are required' USING ERRCODE = '22023';
  END IF;
  IF NOT public.user_can_access_business(v_user, v_business) THEN
    RAISE EXCEPTION 'Access denied for business %', v_business USING ERRCODE = '42501';
  END IF;
  IF v_status NOT IN ('draft','pending_approval') THEN
    RAISE EXCEPTION 'A new sales order may only be created as draft or pending_approval (got %)', v_status
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(NULLIF(p_header->>'currency',''), b.base_currency, 'USD')
    INTO v_currency
    FROM public.businesses b WHERE b.id = v_business;

  -- Phase 6b: the order records the stock location it will reserve against.
  SELECT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) AS t(i)
      JOIN public.products p ON p.id = NULLIF(i->>'product_id','')::uuid
     WHERE COALESCE(p.track_inventory, false) = true
  ) INTO v_tracked;

  IF NULLIF(p_header->>'warehouse_id','') IS NOT NULL OR v_tracked THEN
    v_warehouse := public.resolve_sales_warehouse(
      v_org, v_business, v_branch, NULLIF(p_header->>'warehouse_id','')::uuid);
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    v_ord := v_ord + 1;
    v_display := COALESCE(
      NULLIF(v_item->>'display_quantity','')::numeric,
      NULLIF(v_item->>'quantity','')::numeric,
      1);
    IF v_display <= 0 THEN
      RAISE EXCEPTION 'line %: quantity must be greater than zero', v_ord USING ERRCODE = '22023';
    END IF;

    v_res := public.resolve_line_base_quantity(
      v_business,
      NULLIF(v_item->>'product_id','')::uuid,
      v_display,
      NULLIF(v_item->>'display_uom_id','')::uuid,
      NULLIF(v_item->>'packaging_id','')::uuid);
    v_base := (v_res->>'base_quantity')::numeric;

    v_claimed := NULLIF(v_item->>'quantity','')::numeric;
    IF v_claimed IS NOT NULL AND abs(v_claimed - v_base) > 0.0001 THEN
      RAISE EXCEPTION
        'line %: client base quantity % disagrees with the resolved base quantity % (display % )',
        v_ord, v_claimed, v_base, v_display USING ERRCODE = '22023';
    END IF;

    v_unit_price := COALESCE(NULLIF(v_item->>'unit_price','')::numeric, 0);
    v_disc_pct   := COALESCE(NULLIF(v_item->>'discount_percent','')::numeric, 0);
    v_tax_rate   := COALESCE(NULLIF(v_item->>'tax_rate','')::numeric, 0);
    v_line_total := round(v_display * v_unit_price * (1 - v_disc_pct / 100.0), 2);
    v_tax_amount := round(v_line_total * v_tax_rate / 100.0, 2);

    v_subtotal := v_subtotal + v_line_total;
    v_tax      := v_tax + v_tax_amount;

    v_lines := v_lines || jsonb_build_object(
      'product_id', NULLIF(v_item->>'product_id',''),
      'description', COALESCE(v_item->>'description',''),
      'quantity', v_base,
      'display_quantity', v_display,
      'display_uom_id', v_res->>'display_uom_id',
      'packaging_id', v_res->>'packaging_id',
      'uom_snapshot', v_res->>'uom_snapshot',
      'unit_price', v_unit_price,
      'discount_percent', v_disc_pct,
      'tax_rate', v_tax_rate,
      'tax_amount', v_tax_amount,
      'line_total', v_line_total,
      'sort_order', COALESCE(NULLIF(v_item->>'sort_order','')::int, v_ord - 1),
      'project_id', NULLIF(v_item->>'project_id',''),
      'task_id', NULLIF(v_item->>'task_id','')
    );
  END LOOP;

  v_item_count := v_ord;
  v_total := round(v_subtotal + v_tax - v_discount + v_shipping, 2);
  v_rate  := public.resolve_sales_exchange_rate(v_org, v_business, v_currency, v_order_date);

  v_so_number := public.get_next_so_number(v_org, v_business, v_branch);

  INSERT INTO public.sales_orders (
    organization_id, business_id, branch_id, warehouse_id, so_number, contact_id,
    order_date, expected_date, status, currency, exchange_rate,
    subtotal, tax_amount, discount_amount, shipping_amount, total,
    shipping_address, notes, created_by, salesperson_id, payment_term_id,
    project_id, source_estimate_id
  ) VALUES (
    v_org, v_business, v_branch, v_warehouse, v_so_number,
    NULLIF(p_header->>'contact_id','')::uuid,
    v_order_date,
    NULLIF(p_header->>'expected_date','')::date,
    v_status, v_currency, v_rate,
    round(v_subtotal, 2), round(v_tax, 2), round(v_discount, 2), round(v_shipping, 2), v_total,
    NULLIF(p_header->>'shipping_address',''),
    NULLIF(p_header->>'notes',''),
    v_user,
    COALESCE(NULLIF(p_header->>'salesperson_id','')::uuid, v_user),
    NULLIF(p_header->>'payment_term_id','')::uuid,
    NULLIF(p_header->>'project_id','')::uuid,
    NULLIF(p_header->>'source_estimate_id','')::uuid
  )
  RETURNING id INTO v_so_id;

  INSERT INTO public.sales_order_items (
    sales_order_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order,
    project_id, task_id, packaging_id, display_uom_id, display_quantity, uom_snapshot
  )
  SELECT
    v_so_id,
    NULLIF(i->>'product_id','')::uuid,
    i->>'description',
    (i->>'quantity')::numeric,
    (i->>'unit_price')::numeric,
    (i->>'tax_rate')::numeric,
    (i->>'tax_amount')::numeric,
    (i->>'discount_percent')::numeric,
    (i->>'line_total')::numeric,
    (i->>'sort_order')::int,
    NULLIF(i->>'project_id','')::uuid,
    NULLIF(i->>'task_id','')::uuid,
    NULLIF(i->>'packaging_id','')::uuid,
    NULLIF(i->>'display_uom_id','')::uuid,
    (i->>'display_quantity')::numeric,
    NULLIF(i->>'uom_snapshot','')
  FROM jsonb_array_elements(v_lines) AS t(i);

  RETURN jsonb_build_object(
    'success', true,
    'sales_order_id', v_so_id,
    'so_number', v_so_number,
    'warehouse_id', v_warehouse,
    'subtotal', round(v_subtotal, 2),
    'tax_amount', round(v_tax, 2),
    'total', v_total,
    'exchange_rate', v_rate,
    'item_count', v_item_count
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_delivery_note_atomic(p_payload jsonb, p_lines jsonb, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := (p_payload->>'organization_id')::uuid;
  v_biz uuid := (p_payload->>'business_id')::uuid;
  v_branch uuid := NULLIF(p_payload->>'branch_id','')::uuid;
  v_number text;
  v_id uuid;
  v_warehouse uuid;
BEGIN
  IF v_org IS NULL OR v_biz IS NULL THEN
    RAISE EXCEPTION 'organization_id and business_id are required'
      USING ERRCODE = '22023';
  END IF;

  -- Phase 6b: goods ship FROM a recorded location, chosen by the one resolver.
  v_warehouse := public.resolve_sales_warehouse(
    v_org, v_biz, v_branch, NULLIF(p_payload->>'warehouse_id','')::uuid);

  v_number := public.get_next_delivery_number(v_org, v_biz);

  INSERT INTO public.delivery_notes (
    organization_id, business_id, branch_id, warehouse_id, delivery_number, contact_id,
    delivery_date, status, sales_order_id, shipping_address, driver_name,
    vehicle_number, notes, auto_invoice_on_complete, created_by
  ) VALUES (
    v_org, v_biz, v_branch, v_warehouse, v_number,
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

  RETURN jsonb_build_object('success', true, 'id', v_id, 'delivery_number', v_number,
                            'warehouse_id', v_warehouse);
END;
$function$;

-- 6b.4 confirmation consumes it, and stops lying -----------------------------
CREATE OR REPLACE FUNCTION public.confirm_sales_order_atomic(p_so_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_so          RECORD;
  v_warehouse_id uuid;
  v_item        RECORD;
  v_res         jsonb;
  v_reservations_created int := 0;
  v_reservations_skipped int := 0;
  v_skip_reasons jsonb := '[]'::jsonb;
  v_needs_stock boolean;
BEGIN
  SELECT id, organization_id, business_id, branch_id, warehouse_id, status, so_number
    INTO v_so FROM sales_orders WHERE id = p_so_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sales order not found');
  END IF;

  IF v_so.status NOT IN ('draft','approved') THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Only draft or approved sales orders can be confirmed. Current status: ' || v_so.status);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM sales_order_items soi
      JOIN products p ON p.id = soi.product_id
     WHERE soi.sales_order_id = p_so_id
       AND COALESCE(p.track_inventory, false) = true
       AND (soi.quantity - COALESCE(soi.quantity_fulfilled, 0)) > 0
  ) INTO v_needs_stock;

  IF v_needs_stock THEN
    -- The document's own decision wins; legacy rows without one are resolved now.
    BEGIN
      v_warehouse_id := public.resolve_sales_warehouse(
        v_so.organization_id, v_so.business_id, v_so.branch_id, v_so.warehouse_id);
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Cannot confirm ' || COALESCE(v_so.so_number, '') || ': ' || SQLERRM,
        'warehouse_resolved', false);
    END;

    IF v_so.warehouse_id IS DISTINCT FROM v_warehouse_id THEN
      UPDATE sales_orders SET warehouse_id = v_warehouse_id WHERE id = p_so_id;
    END IF;

    FOR v_item IN
      SELECT soi.id AS item_id, soi.product_id, soi.quantity, soi.quantity_fulfilled
        FROM sales_order_items soi
        LEFT JOIN products p ON p.id = soi.product_id
       WHERE soi.sales_order_id = p_so_id
         AND soi.product_id IS NOT NULL
         AND COALESCE(p.track_inventory, false) = true
         AND (soi.quantity - COALESCE(soi.quantity_fulfilled, 0)) > 0
    LOOP
      v_res := public.reserve_stock_atomic(
        p_organization_id => v_so.organization_id,
        p_product_id      => v_item.product_id,
        p_quantity        => v_item.quantity - COALESCE(v_item.quantity_fulfilled, 0),
        p_source_type     => 'sales_order',
        p_source_id       => p_so_id,
        p_warehouse_id    => v_warehouse_id,
        p_idempotency_key => 'sales_order:' || p_so_id::text || ':' || v_item.item_id::text,
        p_reserved_by     => p_user_id
      );

      IF COALESCE((v_res->>'success')::boolean, false) THEN
        v_reservations_created := v_reservations_created + 1;
      ELSE
        v_reservations_skipped := v_reservations_skipped + 1;
        v_skip_reasons := v_skip_reasons || jsonb_build_object(
          'product_id', v_item.product_id,
          'reason', COALESCE(v_res->>'error', 'unknown'),
          'available', v_res->'available'
        );
      END IF;
    END LOOP;
  END IF;

  UPDATE sales_orders SET status = 'confirmed', updated_at = now() WHERE id = p_so_id;

  RETURN jsonb_build_object(
    'success', true,
    'so_id', p_so_id,
    'warehouse_id', v_warehouse_id,
    'reservations_created', v_reservations_created,
    'reservations_skipped', v_reservations_skipped,
    'skip_reasons', v_skip_reasons,
    'warehouse_resolved', v_warehouse_id IS NOT NULL OR NOT v_needs_stock
  );
END;
$function$;

-- complete_delivery_atomic: prefer the DN's recorded warehouse over a guess.
DO $do$
DECLARE
  v_def text;
  v_old text := $old$  SELECT id, branch_id INTO v_warehouse_id, v_branch_id
    FROM public.warehouses
   WHERE organization_id = v_org_id AND business_id = v_biz_id
     AND COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(v_dn.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND is_active = true AND COALESCE(is_in_transit, false) = false
   ORDER BY is_default DESC NULLS LAST, created_at ASC LIMIT 1;$old$;
  v_new text := $new$  BEGIN
    v_warehouse_id := public.resolve_sales_warehouse(
      v_org_id, v_biz_id, v_dn.branch_id, v_dn.warehouse_id);
  EXCEPTION WHEN OTHERS THEN
    v_warehouse_id := NULL;
  END;
  SELECT branch_id INTO v_branch_id FROM public.warehouses WHERE id = v_warehouse_id;$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'complete_delivery_atomic';

  IF v_def IS NULL OR position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'complete_delivery_atomic: warehouse lookup anchor not found — refusing to patch blindly';
  END IF;

  v_def := replace(v_def, v_old, v_new);
  v_def := replace(v_def,
    'SELECT id, organization_id, business_id, branch_id, sales_order_id, source_invoice_id,',
    'SELECT id, organization_id, business_id, branch_id, warehouse_id, sales_order_id, source_invoice_id,');
  EXECUTE v_def;
END
$do$;

-- Governed write: once an invoice leaves draft, its stock location is history.
CREATE OR REPLACE FUNCTION public._invoices_governed_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_stack text;
  v_owned boolean;
  v_changed text[] := ARRAY[]::text[];
BEGIN
  IF public._is_teardown_for_org(COALESCE(NEW.organization_id, OLD.organization_id)) THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_changed := array_append(v_changed, 'status');
  END IF;
  IF NEW.invoice_number IS DISTINCT FROM OLD.invoice_number THEN
    v_changed := array_append(v_changed, 'invoice_number');
  END IF;
  IF NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
    v_changed := array_append(v_changed, 'journal_entry_id');
  END IF;
  IF COALESCE(NEW.amount_paid, 0) IS DISTINCT FROM COALESCE(OLD.amount_paid, 0) THEN
    v_changed := array_append(v_changed, 'amount_paid');
  END IF;
  IF NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
     AND COALESCE(OLD.status, 'draft') <> 'draft' THEN
    v_changed := array_append(v_changed, 'warehouse_id');
  END IF;

  IF array_length(v_changed, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  GET DIAGNOSTICS v_stack = PG_CONTEXT;

  v_owned :=
       v_stack ILIKE '%set_invoice_status_atomic%'
    OR v_stack ILIKE '%link_invoice_journal_entry_atomic%'
    OR v_stack ILIKE '%_confirm_invoice_core%'
    OR v_stack ILIKE '%confirm_invoice_atomic%'
    OR v_stack ILIKE '%confirm_invoice_and_release_stock_atomic%'
    OR v_stack ILIKE '%void_invoice_atomic%'
    OR v_stack ILIKE '%void_payment_atomic%'
    OR v_stack ILIKE '%record_multi_invoice_payment%'
    OR v_stack ILIKE '%record_advance_payment%'
    OR v_stack ILIKE '%reallocate_payment_atomic%'
    OR v_stack ILIKE '%unapply_payment_atomic%'
    OR v_stack ILIKE '%unreconcile_payment_atomic%'
    OR v_stack ILIKE '%apply_credit_to_invoice_atomic%'
    OR v_stack ILIKE '%apply_customer_deposit_atomic%'
    OR v_stack ILIKE '%issue_credit_note_atomic%'
    OR v_stack ILIKE '%issue_credit_note_for_payment_atomic%'
    OR v_stack ILIKE '%cascade_voided_invoice_allocations%'
    OR v_stack ILIKE '%create_credit_note_atomic%'
    OR v_stack ILIKE '%confirm_credit_note_atomic%'
    OR v_stack ILIKE '%create_sales_return_atomic%'
    OR v_stack ILIKE '%approve_sales_return_atomic%'
    OR v_stack ILIKE '%cancel_delivery_atomic%'
    OR v_stack ILIKE '%create_invoice_from_delivery_atomic%'
    OR v_stack ILIKE '%convert_so_to_invoice_atomic%'
    OR v_stack ILIKE '%convert_estimate_to_invoice_atomic%'
    OR v_stack ILIKE '%convert_proforma_to_invoice_atomic%'
    OR v_stack ILIKE '%create_pos_credit_sale_invoice_atomic%'
    OR v_stack ILIKE '%post_missing_invoice_journals%'
    OR v_stack ILIKE '%update_overdue_invoices%'
    OR v_stack ILIKE '%generate_3pl_invoice%'
    OR v_stack ILIKE '%generate_recurring_invoice%'
    OR v_stack ILIKE '%trg_invoice_lines_repost_revenue%'
    OR v_stack ILIKE '%_execute_organization_delete%';

  IF NOT v_owned THEN
    RAISE EXCEPTION
      'Invoice % — % may only be changed by the invoice engines (set_invoice_status_atomic, confirm_invoice_atomic, void_invoice_atomic, the payment/credit-note routes). Direct writes are rejected.',
      COALESCE(NEW.invoice_number, OLD.invoice_number), array_to_string(v_changed, ', ')
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

NOTIFY pgrst, 'reload schema';