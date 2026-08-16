-- POS Wave — pricing authority hotfix.
--
-- ROOT CAUSE
-- `pos_resolve_line` called the canonical tax resolver as:
--
--   public.resolve_sales_line_tax(
--     p_business_id, p_product_id, p_contact_id, COALESCE(p_at, CURRENT_DATE),
--     NULL, CASE WHEN p_product_id IS NULL THEN NULL ELSE NULL END);
--
-- Argument 5 is a bare NULL (type `unknown`) and argument 6 is an all-NULL
-- CASE expression, which Postgres resolves to `text`. The target signature is
-- resolve_sales_line_tax(uuid, uuid, uuid, date, uuid, numeric); `text` has no
-- implicit cast to `numeric`, so overload resolution fails with 42883:
--   function public.resolve_sales_line_tax(uuid,uuid,uuid,date,unknown,text)
--   does not exist
--
-- PL/pgSQL resolves callee signatures at first EXECUTION, not at CREATE time,
-- so the defect shipped silently and only surfaced when a cashier priced a
-- basket: `pos_quote_cart` -> `pos_resolve_line` -> 42883, which PostgREST
-- returns as HTTP 404. The terminal then fails closed
-- ("Prices could not be confirmed with the server"), which is the correct
-- behaviour — the till must never take money against locally computed prices.
--
-- FIX
-- Type both arguments explicitly. POS never requests a tax override: it has no
-- p_tax_rate_id / p_requested_rate parameter, so the intent is literally
-- "no override" and tax must come from the canonical cascade
-- (exemption > customer > product > company default). The dead CASE expression
-- is removed. No pricing, tax, discount or rounding behaviour changes.

CREATE OR REPLACE FUNCTION public.pos_resolve_line(
  p_business_id uuid,
  p_product_id uuid,
  p_quantity numeric,
  p_requested_unit_price numeric,
  p_discount_type text,
  p_discount_value numeric,
  p_contact_id uuid DEFAULT NULL::uuid,
  p_packaging_id uuid DEFAULT NULL::uuid,
  p_display_uom_id uuid DEFAULT NULL::uuid,
  p_at date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- (b) TAX — canonical cascade (exemption > customer > product > company default).
  -- Both override arguments are explicitly typed NULL: POS never requests a
  -- specific tax rate. Untyped NULLs here break overload resolution at runtime.
  v_tax_res := public.resolve_sales_line_tax(
    p_business_id,
    p_product_id,
    p_contact_id,
    COALESCE(p_at, CURRENT_DATE),
    NULL::uuid,      -- p_tax_rate_id     — no client-supplied rate id
    NULL::numeric);  -- p_requested_rate  — no client-supplied rate
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
END $function$;

REVOKE ALL ON FUNCTION public.pos_resolve_line(uuid,uuid,numeric,numeric,text,numeric,uuid,uuid,uuid,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_resolve_line(uuid,uuid,numeric,numeric,text,numeric,uuid,uuid,uuid,date) TO authenticated, service_role;