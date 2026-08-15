-- ---------------------------------------------------------------------------
-- Phase 4.1 / 4.2 — server-authoritative line pricing
-- ---------------------------------------------------------------------------
-- One resolver, mirroring resolve_line_base_quantity's contract: it answers
-- "what does ONE unit of what the customer is buying cost?" and says where the
-- answer came from. Unit-aware: the price is scaled by the same base-unit
-- factor the quantity contract uses, so a pack of 50 KG never costs the KG price.

CREATE OR REPLACE FUNCTION public.resolve_line_unit_price(
  p_business_id      uuid,
  p_product_id       uuid,
  p_contact_id       uuid DEFAULT NULL,
  p_packaging_id     uuid DEFAULT NULL,
  p_display_uom_id   uuid DEFAULT NULL,
  p_display_quantity numeric DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_qty        jsonb;
  v_factor     numeric;   -- base units per ONE display unit
  v_base_qty   numeric;
  v_price_list uuid;
  v_group_disc numeric := 0;
  v_price      numeric;
  v_source     text;
BEGIN
  IF p_product_id IS NULL THEN
    RETURN jsonb_build_object('unit_price', NULL, 'source', 'manual',
                              'price_list_id', NULL, 'discount_percent', 0, 'factor', 1);
  END IF;

  -- Reuse the quantity contract so price and quantity can never disagree
  -- about what one "display unit" means.
  v_qty := public.resolve_line_base_quantity(
             p_business_id, p_product_id,
             COALESCE(NULLIF(p_display_quantity, 0), 1),
             p_display_uom_id, p_packaging_id);
  v_factor   := COALESCE((v_qty->>'factor')::numeric, 1);
  v_base_qty := COALESCE((v_qty->>'base_quantity')::numeric, COALESCE(p_display_quantity, 1));

  IF p_contact_id IS NOT NULL THEN
    SELECT c.price_list_id, COALESCE(g.discount_percent, 0)
      INTO v_price_list, v_group_disc
      FROM public.contacts c
      LEFT JOIN public.customer_groups g ON g.id = c.customer_group_id
     WHERE c.id = p_contact_id;
    v_group_disc := COALESCE(v_group_disc, 0);
  END IF;

  -- 1. The customer's assigned price list wins. Tiers are expressed in base
  --    units, so compare against the resolved base quantity.
  IF v_price_list IS NOT NULL THEN
    SELECT pli.unit_price INTO v_price
      FROM public.price_list_items pli
      JOIN public.price_lists pl ON pl.id = pli.price_list_id
     WHERE pli.price_list_id = v_price_list
       AND pli.product_id = p_product_id
       AND COALESCE(pli.min_quantity, 0) <= v_base_qty
       AND COALESCE(pl.is_active, true)
       AND (pl.valid_from IS NULL OR pl.valid_from <= now())
       AND (pl.valid_to IS NULL OR pl.valid_to > now())
     ORDER BY COALESCE(pli.min_quantity, 0) DESC
     LIMIT 1;
    IF v_price IS NOT NULL THEN
      RETURN jsonb_build_object(
        'unit_price', round(v_price * v_factor, 6), 'source', 'price_list',
        'price_list_id', v_price_list, 'discount_percent', v_group_disc, 'factor', v_factor);
    END IF;
  END IF;

  -- 2. The business price book. A pack-specific row is already priced per pack,
  --    so it is NOT scaled; a base-unit row is.
  IF p_packaging_id IS NOT NULL THEN
    SELECT pp.price INTO v_price
      FROM public.product_pricing pp
     WHERE pp.business_id = p_business_id
       AND pp.product_id = p_product_id
       AND pp.packaging_id = p_packaging_id
       AND pp.is_active
       AND pp.min_quantity <= COALESCE(p_display_quantity, 1)
       AND pp.effective_from <= now()
       AND (pp.effective_to IS NULL OR pp.effective_to > now())
     ORDER BY pp.min_quantity DESC, pp.effective_from DESC
     LIMIT 1;
    IF v_price IS NOT NULL THEN
      RETURN jsonb_build_object(
        'unit_price', round(v_price, 6), 'source', 'price_book',
        'price_list_id', NULL, 'discount_percent', v_group_disc, 'factor', v_factor);
    END IF;
  END IF;

  SELECT pp.price INTO v_price
    FROM public.product_pricing pp
   WHERE pp.business_id = p_business_id
     AND pp.product_id = p_product_id
     AND pp.packaging_id IS NULL
     AND pp.is_active
     AND pp.min_quantity <= v_base_qty
     AND pp.effective_from <= now()
     AND (pp.effective_to IS NULL OR pp.effective_to > now())
   ORDER BY pp.min_quantity DESC, pp.effective_from DESC
   LIMIT 1;
  IF v_price IS NOT NULL THEN
    RETURN jsonb_build_object(
      'unit_price', round(v_price * v_factor, 6), 'source', 'price_book',
      'price_list_id', NULL, 'discount_percent', v_group_disc, 'factor', v_factor);
  END IF;

  -- 3. The product's own scalar price — the weakest source, kept as a floor.
  SELECT COALESCE(p.unit_price, 0) INTO v_price FROM public.products p WHERE p.id = p_product_id;
  v_source := 'product';
  RETURN jsonb_build_object(
    'unit_price', round(COALESCE(v_price, 0) * v_factor, 6), 'source', v_source,
    'price_list_id', NULL, 'discount_percent', v_group_disc, 'factor', v_factor);
END;
$function$;

-- Provenance column: why a line costs what it costs.
ALTER TABLE public.invoice_items           ADD COLUMN IF NOT EXISTS price_source text;
ALTER TABLE public.sales_order_items       ADD COLUMN IF NOT EXISTS price_source text;
ALTER TABLE public.estimate_items          ADD COLUMN IF NOT EXISTS price_source text;
ALTER TABLE public.credit_note_items       ADD COLUMN IF NOT EXISTS price_source text;
ALTER TABLE public.proforma_invoice_items  ADD COLUMN IF NOT EXISTS price_source text;

-- Stamps price + provenance. Runs AFTER _uom_normalize_line (alphabetically
-- later trigger name) so packaging/UoM are already settled.
CREATE OR REPLACE FUNCTION public._pricing_normalize_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_business uuid;
  v_contact  uuid;
  v_res      jsonb;
  v_row      jsonb;
  v_disc     numeric;
BEGIN
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only price a line that carries no price of its own; a user-entered price
  -- is authoritative and is merely labelled.
  IF COALESCE(NEW.unit_price, 0) <> 0 THEN
    IF TG_OP = 'INSERT' OR NEW.unit_price IS DISTINCT FROM OLD.unit_price THEN
      NEW.price_source := COALESCE(NEW.price_source, 'manual');
    END IF;
    RETURN NEW;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'invoice_items' THEN
      SELECT business_id, contact_id INTO v_business, v_contact FROM public.invoices WHERE id = NEW.invoice_id;
    WHEN 'sales_order_items' THEN
      SELECT business_id, contact_id INTO v_business, v_contact FROM public.sales_orders WHERE id = NEW.sales_order_id;
    WHEN 'estimate_items' THEN
      SELECT business_id, contact_id INTO v_business, v_contact FROM public.estimates WHERE id = NEW.estimate_id;
    WHEN 'credit_note_items' THEN
      SELECT business_id, contact_id INTO v_business, v_contact FROM public.credit_notes WHERE id = NEW.credit_note_id;
    WHEN 'proforma_invoice_items' THEN
      SELECT business_id, contact_id INTO v_business, v_contact FROM public.proforma_invoices WHERE id = NEW.proforma_invoice_id;
    ELSE
      RETURN NEW;
  END CASE;

  v_res := public.resolve_line_unit_price(
             v_business, NEW.product_id, v_contact,
             NEW.packaging_id, NEW.display_uom_id,
             COALESCE(NEW.display_quantity, NEW.quantity, 1));

  NEW.unit_price   := COALESCE((v_res->>'unit_price')::numeric, 0);
  NEW.price_source := v_res->>'source';

  -- Customer-group discount applies only when the line carries none.
  v_row := to_jsonb(NEW);
  IF v_row ? 'discount_percent' THEN
    v_disc := COALESCE((v_res->>'discount_percent')::numeric, 0);
    IF v_disc > 0 AND COALESCE((v_row->>'discount_percent')::numeric, 0) = 0 THEN
      NEW := jsonb_populate_record(NEW, jsonb_build_object('discount_percent', v_disc));
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_zz_pricing_normalize_invoice_items ON public.invoice_items;
CREATE TRIGGER trg_zz_pricing_normalize_invoice_items
  BEFORE INSERT OR UPDATE ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._pricing_normalize_line();

DROP TRIGGER IF EXISTS trg_zz_pricing_normalize_sales_order_items ON public.sales_order_items;
CREATE TRIGGER trg_zz_pricing_normalize_sales_order_items
  BEFORE INSERT OR UPDATE ON public.sales_order_items
  FOR EACH ROW EXECUTE FUNCTION public._pricing_normalize_line();

DROP TRIGGER IF EXISTS trg_zz_pricing_normalize_estimate_items ON public.estimate_items;
CREATE TRIGGER trg_zz_pricing_normalize_estimate_items
  BEFORE INSERT OR UPDATE ON public.estimate_items
  FOR EACH ROW EXECUTE FUNCTION public._pricing_normalize_line();

DROP TRIGGER IF EXISTS trg_zz_pricing_normalize_credit_note_items ON public.credit_note_items;
CREATE TRIGGER trg_zz_pricing_normalize_credit_note_items
  BEFORE INSERT OR UPDATE ON public.credit_note_items
  FOR EACH ROW EXECUTE FUNCTION public._pricing_normalize_line();

DROP TRIGGER IF EXISTS trg_zz_pricing_normalize_proforma_items ON public.proforma_invoice_items;
CREATE TRIGGER trg_zz_pricing_normalize_proforma_items
  BEFORE INSERT OR UPDATE ON public.proforma_invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._pricing_normalize_line();