-- Sales line totals must be computed against the unit the price is quoted in.
--
-- `resolve_line_unit_price` returns a price PER DISPLAY UNIT (it scales the
-- base price by the packaging factor), and `create_invoice_atomic` computes
-- its header subtotal as display_quantity * unit_price. `_totals_normalize_line`
-- however multiplied by the BASE quantity, so a line of "2 x 50 Kg Bag @ 7,000"
-- was stamped 700,000 instead of 14,000 (a 50x overcharge) and the stored line
-- disagreed with the header the creator returned.
--
-- Money quantity  = display_quantity (the unit the price is quoted in).
-- Ledger quantity = quantity (base units) — unchanged, still what inventory,
-- reservations and COGS consume.
-- Per-unit fixed duties/levies stay on the BASE quantity: an excise stamp is
-- charged per kilogram, not per bag.

CREATE OR REPLACE FUNCTION public._totals_normalize_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_business uuid;
  v_contact  uuid;
  v_status   text;
  v_header   text;
  v_date     date;
  v_row      jsonb;
  v_tax      jsonb;
  v_rate     numeric := 0;
  v_incl     boolean := false;
  v_fixed    numeric := 0;
  v_rate_id  uuid;
  v_qty      numeric;
  v_base_qty numeric;
  v_price    numeric;
  v_disc_pct numeric := 0;
  v_gross    numeric;
  v_disc     numeric;
  v_taxable  numeric;
  v_tax_amt  numeric;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'invoice_items' THEN
      v_header := 'invoices';
      SELECT business_id, contact_id, status::text, issue_date
        INTO v_business, v_contact, v_status, v_date
        FROM public.invoices WHERE id = NEW.invoice_id;
    WHEN 'sales_order_items' THEN
      v_header := 'sales_orders';
      SELECT business_id, contact_id, status::text, order_date
        INTO v_business, v_contact, v_status, v_date
        FROM public.sales_orders WHERE id = NEW.sales_order_id;
    WHEN 'estimate_items' THEN
      v_header := 'estimates';
      SELECT business_id, contact_id, status::text, issue_date
        INTO v_business, v_contact, v_status, v_date
        FROM public.estimates WHERE id = NEW.estimate_id;
    WHEN 'credit_note_items' THEN
      v_header := 'credit_notes';
      SELECT business_id, contact_id, status::text, issue_date
        INTO v_business, v_contact, v_status, v_date
        FROM public.credit_notes WHERE id = NEW.credit_note_id;
    WHEN 'proforma_invoice_items' THEN
      v_header := 'proforma_invoices';
      SELECT business_id, contact_id, status::text, issue_date
        INTO v_business, v_contact, v_status, v_date
        FROM public.proforma_invoices WHERE id = NEW.proforma_invoice_id;
    ELSE
      RETURN NEW;
  END CASE;

  IF NOT public._sales_doc_is_mutable(v_header, v_status) THEN
    RETURN NEW;
  END IF;

  v_row  := to_jsonb(NEW);
  v_date := COALESCE(v_date, CURRENT_DATE);

  v_tax := public.resolve_sales_line_tax(
    v_business,
    NEW.product_id,
    v_contact,
    v_date,
    CASE WHEN v_row ? 'tax_rate_id' THEN NULLIF(v_row->>'tax_rate_id','')::uuid END,
    COALESCE((v_row->>'tax_rate')::numeric, 0));

  v_rate    := COALESCE((v_tax->>'rate')::numeric, 0);
  v_incl    := COALESCE((v_tax->>'is_inclusive')::boolean, false);
  v_fixed   := COALESCE((v_tax->>'fixed_amount')::numeric, 0);
  v_rate_id := NULLIF(v_tax->>'tax_rate_id','')::uuid;

  v_base_qty := COALESCE((v_row->>'quantity')::numeric, 0);
  -- The priced quantity is the customer-facing one; `_uom_normalize_line`
  -- has already run and guarantees display_quantity is populated.
  v_qty   := COALESCE(NULLIF((v_row->>'display_quantity'),'')::numeric, v_base_qty);
  v_price := COALESCE((v_row->>'unit_price')::numeric, 0);

  IF v_row ? 'discount_percent' THEN
    v_disc_pct := COALESCE((v_row->>'discount_percent')::numeric, 0);
  END IF;

  v_gross := ROUND(v_qty * v_price, 2);

  -- A tax-inclusive rate means the stamped unit price already carries the tax.
  IF v_incl AND v_rate <> 0 THEN
    v_gross := ROUND(v_gross / (1 + v_rate / 100.0), 2);
  END IF;

  v_disc    := ROUND(v_gross * v_disc_pct / 100.0, 2);
  v_taxable := ROUND(v_gross - v_disc, 2);
  -- Percentage component plus any per-unit fixed duty/levy, which is charged
  -- per BASE unit (per kg, per litre) and never per pack.
  v_tax_amt := ROUND(v_taxable * v_rate / 100.0, 2) + ROUND(v_fixed * v_base_qty, 2);

  NEW := jsonb_populate_record(NEW, jsonb_build_object(
    'tax_rate',    v_rate,
    'tax_rate_id', v_rate_id,
    'tax_amount',  v_tax_amt,
    'line_total',  v_taxable
  ));

  RETURN NEW;
END;
$function$;