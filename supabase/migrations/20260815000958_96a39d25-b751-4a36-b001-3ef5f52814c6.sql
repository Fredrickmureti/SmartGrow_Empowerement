-- =====================================================================
-- Sales Phase 3 — the line quantity contract
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Preserve dependent views, widen quantity precision, restore views
-- ---------------------------------------------------------------------
CREATE TEMP TABLE _sales_phase3_views AS
SELECT c.relname::text AS relname,
       pg_get_viewdef(c.oid, true) AS def,
       (c.reloptions IS NOT NULL AND 'security_invoker=true' = ANY (c.reloptions)) AS security_invoker
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind = 'v'
   AND c.relname IN ('dn_line_balances','so_line_balances','so_backorder_lines',
                     'v_invoice_creditable_qty','v_lot_downstream_consumption',
                     'v_sales_returnable_qty');

DROP VIEW IF EXISTS public.so_backorder_lines CASCADE;
DROP VIEW IF EXISTS public.so_line_balances CASCADE;
DROP VIEW IF EXISTS public.dn_line_balances CASCADE;
DROP VIEW IF EXISTS public.v_invoice_creditable_qty CASCADE;
DROP VIEW IF EXISTS public.v_sales_returnable_qty CASCADE;
DROP VIEW IF EXISTS public.v_lot_downstream_consumption CASCADE;

-- Triggers declared with UPDATE OF <column> also pin the column type.
DROP TRIGGER IF EXISTS trg_invoice_items_so_ledger ON public.invoice_items;

ALTER TABLE public.invoice_items      ALTER COLUMN quantity TYPE numeric(15,4);
ALTER TABLE public.estimate_items     ALTER COLUMN quantity TYPE numeric(15,4);
ALTER TABLE public.credit_note_items  ALTER COLUMN quantity TYPE numeric(15,4);
ALTER TABLE public.sales_order_items  ALTER COLUMN quantity TYPE numeric(15,4);
ALTER TABLE public.delivery_note_items ALTER COLUMN quantity_delivered TYPE numeric(15,4);
ALTER TABLE public.delivery_note_items ALTER COLUMN quantity_ordered  TYPE numeric(15,4);

CREATE TRIGGER trg_invoice_items_so_ledger
  AFTER INSERT OR DELETE OR UPDATE OF quantity, sales_order_item_id ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_so_item_invoiced_qty();

DO $rebuild$
DECLARE
  r record;
  remaining int;
  progressed boolean;
BEGIN
  LOOP
    progressed := false;
    FOR r IN SELECT * FROM _sales_phase3_views LOOP
      BEGIN
        EXECUTE format(
          'CREATE VIEW public.%I %s AS %s',
          r.relname,
          CASE WHEN r.security_invoker THEN 'WITH (security_invoker=true)' ELSE '' END,
          r.def);
        EXECUTE format('GRANT ALL ON public.%I TO anon, authenticated, service_role', r.relname);
        DELETE FROM _sales_phase3_views WHERE relname = r.relname;
        progressed := true;
      EXCEPTION WHEN others THEN
        NULL; -- dependency not yet available; retry on the next pass
      END;
    END LOOP;
    SELECT count(*) INTO remaining FROM _sales_phase3_views;
    EXIT WHEN remaining = 0;
    IF NOT progressed THEN
      RAISE EXCEPTION 'could not recreate views: %',
        (SELECT string_agg(relname, ', ') FROM _sales_phase3_views);
    END IF;
  END LOOP;
END
$rebuild$;

DROP TABLE _sales_phase3_views;

COMMENT ON COLUMN public.sales_order_items.quantity IS
  'Canonical quantity in the product base UoM. Derived server-side from display_quantity x (packaging.qty_in_base_uom | convert_uom). Never write this from the browser.';
COMMENT ON COLUMN public.invoice_items.quantity IS
  'Canonical quantity in the product base UoM. See sales_order_items.quantity.';
COMMENT ON COLUMN public.estimate_items.quantity IS
  'Canonical quantity in the product base UoM. See sales_order_items.quantity.';
COMMENT ON COLUMN public.credit_note_items.quantity IS
  'Canonical quantity in the product base UoM. See sales_order_items.quantity.';
COMMENT ON COLUMN public.delivery_note_items.quantity_delivered IS
  'Canonical quantity in the product base UoM (matches uom_snapshot). Consumed directly by inventory movements.';
COMMENT ON COLUMN public.sales_order_items.display_quantity IS
  'What the customer bought, expressed in display_uom_id or packaging_id. Customer-facing and auditable.';

-- ---------------------------------------------------------------------
-- 2. Canonical line quantity resolver (UoM domain — reusable by any document)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_line_base_quantity(
  p_business_id uuid,
  p_product_id uuid,
  p_display_quantity numeric,
  p_display_uom_id uuid DEFAULT NULL,
  p_packaging_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_base_uom   uuid;
  v_pack_qty   numeric;
  v_pack_prod  uuid;
  v_pack_name  text;
  v_base       numeric;
  v_snapshot   text;
BEGIN
  IF p_display_quantity IS NULL THEN
    RAISE EXCEPTION 'resolve_line_base_quantity: display quantity is required' USING ERRCODE = '22023';
  END IF;

  -- Free-text line (no catalogue product): nothing to convert.
  IF p_product_id IS NULL THEN
    RETURN jsonb_build_object(
      'base_quantity', p_display_quantity,
      'display_quantity', p_display_quantity,
      'display_uom_id', p_display_uom_id,
      'packaging_id', NULL,
      'base_uom_id', NULL,
      'uom_snapshot', NULL,
      'factor', 1);
  END IF;

  SELECT p.base_uom_id INTO v_base_uom
    FROM public.products p
   WHERE p.id = p_product_id
     AND (p_business_id IS NULL OR p.business_id = p_business_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolve_line_base_quantity: product % not found in business %',
      p_product_id, p_business_id USING ERRCODE = '22023';
  END IF;

  -- Packaging wins when supplied: the multiplier is authoritative.
  IF p_packaging_id IS NOT NULL THEN
    SELECT pk.qty_in_base_uom, pk.product_id, pk.name
      INTO v_pack_qty, v_pack_prod, v_pack_name
      FROM public.product_packaging pk
     WHERE pk.id = p_packaging_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'resolve_line_base_quantity: packaging % not found', p_packaging_id
        USING ERRCODE = '22023';
    END IF;
    IF v_pack_prod IS DISTINCT FROM p_product_id THEN
      RAISE EXCEPTION 'resolve_line_base_quantity: packaging % does not belong to product %',
        p_packaging_id, p_product_id USING ERRCODE = '22023';
    END IF;
    IF COALESCE(v_pack_qty, 0) <= 0 THEN
      RAISE EXCEPTION 'resolve_line_base_quantity: packaging % has no positive qty_in_base_uom',
        p_packaging_id USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object(
      'base_quantity', p_display_quantity * v_pack_qty,
      'display_quantity', p_display_quantity,
      'display_uom_id', p_display_uom_id,
      'packaging_id', p_packaging_id,
      'base_uom_id', v_base_uom,
      'uom_snapshot', v_pack_name,
      'factor', v_pack_qty);
  END IF;

  -- Alternate selling unit: the canonical UoM engine converts (and rejects
  -- cross-dimension conversions such as kg -> piece).
  IF p_display_uom_id IS NOT NULL AND v_base_uom IS NOT NULL
     AND p_display_uom_id <> v_base_uom THEN
    v_base := public.convert_uom(p_display_quantity, p_display_uom_id, v_base_uom);
    SELECT u.code INTO v_snapshot FROM public.units_of_measure u WHERE u.id = p_display_uom_id;
    RETURN jsonb_build_object(
      'base_quantity', v_base,
      'display_quantity', p_display_quantity,
      'display_uom_id', p_display_uom_id,
      'packaging_id', NULL,
      'base_uom_id', v_base_uom,
      'uom_snapshot', v_snapshot,
      'factor', CASE WHEN p_display_quantity <> 0 THEN v_base / p_display_quantity ELSE NULL END);
  END IF;

  -- Selling in the base unit (or the product has no UoM configured).
  SELECT u.code INTO v_snapshot
    FROM public.units_of_measure u
   WHERE u.id = COALESCE(p_display_uom_id, v_base_uom);
  RETURN jsonb_build_object(
    'base_quantity', p_display_quantity,
    'display_quantity', p_display_quantity,
    'display_uom_id', COALESCE(p_display_uom_id, v_base_uom),
    'packaging_id', NULL,
    'base_uom_id', v_base_uom,
    'uom_snapshot', v_snapshot,
    'factor', 1);
END
$function$;

COMMENT ON FUNCTION public.resolve_line_base_quantity(uuid, uuid, numeric, uuid, uuid) IS
  'Canonical customer-unit -> base-unit resolver for document lines. Composes product_packaging.qty_in_base_uom and convert_uom. Returns base_quantity, the echoed display fields, base_uom_id, a text uom_snapshot and the conversion factor.';

-- ---------------------------------------------------------------------
-- 3. Widen the product read seam with UoM / packaging context
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.list_products_with_branch_stock(uuid, uuid, uuid, boolean);

CREATE FUNCTION public.list_products_with_branch_stock(
  p_org_id uuid,
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_include_variant_parents boolean DEFAULT false)
RETURNS TABLE(
  id uuid, organization_id uuid, business_id uuid, type text, name text, description text,
  sku text, unit_price numeric, cost_price numeric, tax_rate numeric, tax_rate_id uuid,
  is_active boolean, image_url text, category_id uuid, track_inventory boolean,
  reorder_level numeric, min_order_quantity numeric, order_quantity_increment numeric,
  sales_account_id uuid, cogs_account_id uuid, inventory_account_id uuid, purchase_account_id uuid,
  base_uom_id uuid, base_uom_code text, base_uom_name text,
  sales_uom_id uuid, sales_uom_code text, sales_uom_name text,
  packaging jsonb,
  on_hand numeric, reserved numeric, available numeric, branch_scope_label text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_branch_label text;
  v_ids uuid[];
BEGIN
  IF NOT public.user_has_business_access(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'access denied for business %', p_business_id USING ERRCODE = '42501';
  END IF;

  IF p_branch_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = p_branch_id AND b.business_id = p_business_id) THEN
      RAISE EXCEPTION 'branch % does not belong to business %', p_branch_id, p_business_id USING ERRCODE = '22023';
    END IF;
    SELECT b.name INTO v_branch_label FROM public.branches b WHERE b.id = p_branch_id;
    v_branch_label := COALESCE(v_branch_label, 'Branch');
  ELSE
    v_branch_label := 'All branches';
  END IF;

  SELECT array_agg(p.id)
    INTO v_ids
    FROM public.products p
   WHERE p.organization_id = p_org_id
     AND p.business_id = p_business_id
     AND p.is_active = true
     AND (p_include_variant_parents OR NOT COALESCE(p.is_variant_parent, false));

  RETURN QUERY
  WITH stock AS (
    SELECT a.product_id, a.on_hand, a.reserved, a.available
      FROM public.resolve_stock_availability_batch(
             COALESCE(v_ids, ARRAY[]::uuid[]), p_business_id, p_branch_id) a
  ), packs AS (
    SELECT pk.product_id,
           jsonb_agg(
             jsonb_build_object(
               'id', pk.id,
               'name', pk.name,
               'qty_in_base_uom', pk.qty_in_base_uom,
               'is_sales_default', COALESCE(pk.is_sales_default, false),
               'is_shipping_unit', COALESCE(pk.is_shipping_unit, false)
             ) ORDER BY pk.qty_in_base_uom
           ) AS levels
      FROM public.product_packaging pk
     WHERE pk.product_id = ANY (COALESCE(v_ids, ARRAY[]::uuid[]))
     GROUP BY pk.product_id
  )
  SELECT
    p.id, p.organization_id, p.business_id, p.type::text, p.name, p.description, p.sku,
    p.unit_price, p.cost_price, p.tax_rate, p.tax_rate_id, p.is_active, p.image_url, p.category_id,
    p.track_inventory, p.reorder_level, p.min_order_quantity, p.order_quantity_increment,
    p.sales_account_id, p.cogs_account_id, p.inventory_account_id, p.purchase_account_id,
    p.base_uom_id, bu.code, bu.name,
    p.sales_uom_id, su.code, su.name,
    COALESCE(pk.levels, '[]'::jsonb),
    COALESCE(s.on_hand, 0)::numeric,
    COALESCE(s.reserved, 0)::numeric,
    COALESCE(s.available, 0)::numeric,
    v_branch_label
  FROM public.products p
  LEFT JOIN stock s ON s.product_id = p.id
  LEFT JOIN packs pk ON pk.product_id = p.id
  LEFT JOIN public.units_of_measure bu ON bu.id = p.base_uom_id
  LEFT JOIN public.units_of_measure su ON su.id = p.sales_uom_id
  WHERE p.id = ANY (COALESCE(v_ids, ARRAY[]::uuid[]))
  ORDER BY p.name;
END;
$function$;

-- ---------------------------------------------------------------------
-- 4. Sales order creation derives the base quantity and the line money
-- ---------------------------------------------------------------------
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

  -- Quantity contract: the caller states what the CUSTOMER bought
  -- (display_quantity + display_uom_id | packaging_id). The canonical base
  -- quantity, and the line money, are derived here — never trusted.
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

    -- A client that also sends a base quantity must agree with the engine.
    v_claimed := NULLIF(v_item->>'quantity','')::numeric;
    IF v_claimed IS NOT NULL AND abs(v_claimed - v_base) > 0.0001 THEN
      RAISE EXCEPTION
        'line %: client base quantity % disagrees with the resolved base quantity % (display % )',
        v_ord, v_claimed, v_base, v_display USING ERRCODE = '22023';
    END IF;

    v_unit_price := COALESCE(NULLIF(v_item->>'unit_price','')::numeric, 0);
    v_disc_pct   := COALESCE(NULLIF(v_item->>'discount_percent','')::numeric, 0);
    v_tax_rate   := COALESCE(NULLIF(v_item->>'tax_rate','')::numeric, 0);
    -- Price is per CUSTOMER unit, so money follows the display quantity.
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
    organization_id, business_id, branch_id, so_number, contact_id,
    order_date, expected_date, status, currency, exchange_rate,
    subtotal, tax_amount, discount_amount, shipping_amount, total,
    shipping_address, notes, created_by, salesperson_id, payment_term_id,
    project_id, source_estimate_id
  ) VALUES (
    v_org, v_business, v_branch, v_so_number,
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
    'subtotal', round(v_subtotal, 2),
    'tax_amount', round(v_tax, 2),
    'total', v_total,
    'exchange_rate', v_rate,
    'item_count', v_item_count
  );
END;
$function$;