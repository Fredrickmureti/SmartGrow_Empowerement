-- ============================================================
-- POS Wave · Phase 4 — pricing & tax authority
-- POS must not own pricing or tax logic. pos_resolve_line becomes a thin
-- adapter over the canonical resolvers (resolve_line_unit_price /
-- resolve_sales_line_tax), and a cart-level quote RPC gives the till a
-- server-computed basket instead of client money math.
-- ============================================================

-- 1) Single signature only (Phase 1 lesson: no overload ambiguity).
DROP FUNCTION IF EXISTS public.pos_resolve_line(uuid,uuid,numeric,numeric,text,numeric);

CREATE OR REPLACE FUNCTION public.pos_resolve_line(
  p_business_id uuid,
  p_product_id uuid,
  p_quantity numeric,
  p_requested_unit_price numeric,
  p_discount_type text,
  p_discount_value numeric,
  p_contact_id uuid DEFAULT NULL,
  p_packaging_id uuid DEFAULT NULL,
  p_display_uom_id uuid DEFAULT NULL,
  p_at date DEFAULT CURRENT_DATE
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_price_res jsonb;
  v_tax_res   jsonb;
  v_catalog_price numeric := 0;
  v_unit_price numeric := 0;
  v_group_disc numeric := 0;
  v_tax_rate numeric := 0;
  v_tax_rate_id uuid;
  v_inclusive boolean := false;
  v_fixed numeric := 0;
  v_discount_amount numeric := 0;
  v_group_amount numeric := 0;
  v_gross numeric := 0;
  v_taxable numeric := 0;
  v_tax_amount numeric := 0;
  v_line_total numeric := 0;
  v_qty numeric := COALESCE(p_quantity, 0);
BEGIN
  IF p_product_id IS NULL THEN
    -- Non-catalog line: the typed price stands, tax still validated server-side.
    v_unit_price := COALESCE(p_requested_unit_price, 0);
    v_catalog_price := v_unit_price;
  ELSE
    -- (a) PRICE — canonical authority (price list > price book/pack > product scalar)
    v_price_res := public.resolve_line_unit_price(
      p_business_id, p_product_id, p_contact_id,
      p_packaging_id, p_display_uom_id, 1);
    v_catalog_price := COALESCE((v_price_res->>'unit_price')::numeric, 0);
    v_group_disc := COALESCE((v_price_res->>'discount_percent')::numeric, 0);
    v_unit_price := v_catalog_price;
  END IF;

  -- (b) TAX — canonical cascade (exemption > customer > product > company default)
  v_tax_res := public.resolve_sales_line_tax(
    p_business_id, p_product_id, p_contact_id, COALESCE(p_at, CURRENT_DATE),
    NULL, CASE WHEN p_product_id IS NULL THEN NULL ELSE NULL END);
  v_tax_rate    := COALESCE((v_tax_res->>'rate')::numeric, 0);
  v_tax_rate_id := NULLIF(v_tax_res->>'tax_rate_id','')::uuid;
  v_inclusive   := COALESCE((v_tax_res->>'is_inclusive')::boolean, false);
  v_fixed       := COALESCE((v_tax_res->>'fixed_amount')::numeric, 0);

  -- Tax-inclusive rates: the shelf price already contains the tax, so the
  -- net (taxable) price is derived rather than grossed up.
  IF v_inclusive AND v_tax_rate <> 0 THEN
    v_unit_price := ROUND(v_unit_price / (1 + v_tax_rate / 100.0), 6);
  END IF;

  v_gross := v_unit_price * v_qty;

  -- (c) Customer-group discount is part of the pricing contract, applied first.
  IF v_group_disc > 0 THEN
    v_group_amount := ROUND(v_gross * v_group_disc / 100.0, 4);
  END IF;

  -- (d) Line discount policy: percentage or fixed on the pre-tax subtotal.
  IF p_discount_type IN ('percentage', 'percent') THEN
    v_discount_amount := ROUND((v_gross - v_group_amount) * COALESCE(p_discount_value, 0) / 100.0, 4);
  ELSIF p_discount_type = 'fixed' THEN
    v_discount_amount := LEAST(GREATEST(v_gross - v_group_amount, 0), COALESCE(p_discount_value, 0));
  ELSE
    v_discount_amount := 0;
  END IF;
  v_discount_amount := v_discount_amount + v_group_amount;

  v_taxable := GREATEST(0, v_gross - v_discount_amount);
  v_tax_amount := ROUND(v_taxable * v_tax_rate / 100.0, 4) + ROUND(v_fixed * v_qty, 4);
  v_line_total := ROUND(v_taxable + v_tax_amount, 4);

  RETURN jsonb_build_object(
    'unit_price', v_unit_price,
    'catalog_price', v_catalog_price,
    'price_source', COALESCE(v_price_res->>'source', 'manual'),
    'price_list_id', NULLIF(v_price_res->>'price_list_id',''),
    'group_discount_percent', v_group_disc,
    'tax_rate', v_tax_rate,
    'tax_rate_id', v_tax_rate_id,
    'tax_inclusive', v_inclusive,
    'tax_source', COALESCE(v_tax_res->>'source', 'none'),
    'discount_amount', v_discount_amount,
    'taxable', v_taxable,
    'tax_amount', v_tax_amount,
    'line_total', v_line_total
  );
END $fn$;

REVOKE ALL ON FUNCTION public.pos_resolve_line(uuid,uuid,numeric,numeric,text,numeric,uuid,uuid,uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_resolve_line(uuid,uuid,numeric,numeric,text,numeric,uuid,uuid,uuid,date)
  TO authenticated, service_role;

-- 2) Cart-level quote: the till asks the server what the basket costs.
CREATE OR REPLACE FUNCTION public.pos_quote_cart(
  p_register_id uuid,
  p_lines jsonb,
  p_contact_id uuid DEFAULT NULL,
  p_cart_discount_type text DEFAULT NULL,
  p_cart_discount_value numeric DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_business_id uuid;
  v_branch_id uuid;
  v_line jsonb;
  v_res jsonb;
  v_out jsonb := '[]'::jsonb;
  v_subtotal numeric := 0;      -- net of line discounts, pre-tax
  v_line_disc numeric := 0;
  v_tax numeric := 0;
  v_cart_disc numeric := 0;
  v_factor numeric := 1;
BEGIN
  SELECT s.business_id, s.branch_id INTO v_business_id, v_branch_id
    FROM public.pos_register_stock_scope(p_register_id) s;
  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'register % has no resolvable scope', p_register_id USING ERRCODE = '22023';
  END IF;
  PERFORM public.assert_pos_caller_branch_access(v_branch_id);

  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb)) LOOP
    v_res := public.pos_resolve_line(
      v_business_id,
      NULLIF(v_line->>'product_id','')::uuid,
      COALESCE((v_line->>'quantity')::numeric, 0),
      COALESCE((v_line->>'unit_price')::numeric, 0),
      v_line->>'discount_type',
      COALESCE((v_line->>'discount_value')::numeric, 0),
      p_contact_id,
      NULLIF(v_line->>'packaging_id','')::uuid,
      NULLIF(v_line->>'display_uom_id','')::uuid,
      CURRENT_DATE);

    v_subtotal  := v_subtotal  + COALESCE((v_res->>'taxable')::numeric, 0);
    v_line_disc := v_line_disc + COALESCE((v_res->>'discount_amount')::numeric, 0);
    v_tax       := v_tax       + COALESCE((v_res->>'tax_amount')::numeric, 0);

    v_out := v_out || jsonb_build_array(
      v_res || jsonb_build_object('line_id', v_line->>'line_id',
                                  'product_id', v_line->>'product_id',
                                  'quantity', COALESCE((v_line->>'quantity')::numeric, 0)));
  END LOOP;

  -- Cart-level discount, then tax is scaled proportionally so the tax base
  -- never exceeds what the customer actually pays.
  IF p_cart_discount_type IN ('percentage','percent') THEN
    v_cart_disc := ROUND(v_subtotal * COALESCE(p_cart_discount_value,0) / 100.0, 4);
  ELSIF p_cart_discount_type = 'fixed' THEN
    v_cart_disc := LEAST(v_subtotal, COALESCE(p_cart_discount_value, 0));
  END IF;
  v_cart_disc := GREATEST(0, LEAST(v_cart_disc, v_subtotal));

  IF v_subtotal > 0 AND v_cart_disc > 0 THEN
    v_factor := (v_subtotal - v_cart_disc) / v_subtotal;
    v_tax := ROUND(v_tax * v_factor, 4);
  END IF;

  RETURN jsonb_build_object(
    'business_id', v_business_id,
    'branch_id', v_branch_id,
    'quoted_at', now(),
    'lines', v_out,
    'subtotal', ROUND(v_subtotal, 4),
    'line_discount_amount', ROUND(v_line_disc, 4),
    'cart_discount_amount', ROUND(v_cart_disc, 4),
    'discount_amount', ROUND(v_line_disc + v_cart_disc, 4),
    'tax_amount', ROUND(v_tax, 4),
    'total', ROUND(v_subtotal - v_cart_disc + v_tax, 4)
  );
END $fn$;

REVOKE ALL ON FUNCTION public.pos_quote_cart(uuid,jsonb,uuid,text,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_quote_cart(uuid,jsonb,uuid,text,numeric) TO authenticated, service_role;

-- 3) Commit path must price with the same inputs as the quote (customer + pack).
DO $mig$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'process_pos_transaction';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'process_pos_transaction not found';
  END IF;

  v_new := replace(
    v_def,
    'v_req_unit_price, v_req_discount_type, v_req_discount_value);',
    'v_req_unit_price, v_req_discount_type, v_req_discount_value,'
    || ' p_customer_id,'
    || ' NULLIF(v_item->>''packaging_id'','''')::uuid,'
    || ' NULLIF(v_item->>''display_uom_id'','''')::uuid,'
    || ' CURRENT_DATE);');

  IF v_new = v_def THEN
    RAISE EXCEPTION 'could not locate the pos_resolve_line call site in process_pos_transaction';
  END IF;

  EXECUTE v_new;
END $mig$;