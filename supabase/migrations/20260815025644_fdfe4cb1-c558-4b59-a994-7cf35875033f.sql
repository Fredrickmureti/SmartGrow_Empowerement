-- Phase 7: sale-time tax resolution owned by the Tax domain.

ALTER TABLE public.invoice_items           ADD COLUMN IF NOT EXISTS tax_rate_id uuid REFERENCES public.tax_rates(id);
ALTER TABLE public.sales_order_items       ADD COLUMN IF NOT EXISTS tax_rate_id uuid REFERENCES public.tax_rates(id);
ALTER TABLE public.estimate_items          ADD COLUMN IF NOT EXISTS tax_rate_id uuid REFERENCES public.tax_rates(id);
ALTER TABLE public.credit_note_items       ADD COLUMN IF NOT EXISTS tax_rate_id uuid REFERENCES public.tax_rates(id);
ALTER TABLE public.proforma_invoice_items  ADD COLUMN IF NOT EXISTS tax_rate_id uuid REFERENCES public.tax_rates(id);

COMMENT ON COLUMN public.invoice_items.tax_rate_id IS
  'Tax rate actually applied to this line, stamped by resolve_sales_line_tax(). Audit snapshot; never client-authoritative.';
COMMENT ON COLUMN public.sales_order_items.tax_rate_id IS
  'Tax rate actually applied to this line, stamped by resolve_sales_line_tax().';
COMMENT ON COLUMN public.estimate_items.tax_rate_id IS
  'Tax rate actually applied to this line, stamped by resolve_sales_line_tax().';
COMMENT ON COLUMN public.credit_note_items.tax_rate_id IS
  'Tax rate actually applied to this line, stamped by resolve_sales_line_tax().';
COMMENT ON COLUMN public.proforma_invoice_items.tax_rate_id IS
  'Tax rate actually applied to this line, stamped by resolve_sales_line_tax().';

-- The ONE sale-time tax resolver. Sales calls it; Sales never decides tax.
CREATE OR REPLACE FUNCTION public.resolve_sales_line_tax(
  p_business_id    uuid,
  p_product_id     uuid,
  p_contact_id     uuid,
  p_date           date DEFAULT CURRENT_DATE,
  p_tax_rate_id    uuid DEFAULT NULL,
  p_requested_rate numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_date     date := COALESCE(p_date, CURRENT_DATE);
  v_tr       public.tax_rates%ROWTYPE;
  v_res      jsonb;
  v_rate     numeric;
  v_match    uuid;
BEGIN
  IF p_business_id IS NULL THEN
    RETURN jsonb_build_object('rate', 0, 'tax_rate_id', NULL, 'is_inclusive', false,
                              'fixed_amount', 0, 'tax_type', NULL, 'source', 'none');
  END IF;

  -- (1) An explicitly chosen rate must be this company's, active and in force.
  IF p_tax_rate_id IS NOT NULL THEN
    SELECT * INTO v_tr
      FROM public.tax_rates tr
     WHERE tr.id = p_tax_rate_id
       AND tr.business_id = p_business_id
       AND COALESCE(tr.is_active, true)
       AND (tr.effective_from IS NULL OR tr.effective_from <= v_date)
       AND (tr.effective_to   IS NULL OR tr.effective_to   >= v_date);
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'tax rate % is not an active rate for this company on %', p_tax_rate_id, v_date
        USING ERRCODE = '22023';
    END IF;
    IF COALESCE(v_tr.is_compound, false) THEN
      RAISE EXCEPTION
        'compound tax rate % is not supported on a sales line (one tax per line)', p_tax_rate_id
        USING ERRCODE = '0A000';
    END IF;
    RETURN jsonb_build_object(
      'rate', COALESCE(v_tr.rate, 0), 'tax_rate_id', v_tr.id,
      'is_inclusive', COALESCE(v_tr.is_inclusive, false),
      'fixed_amount', COALESCE(v_tr.fixed_amount, 0),
      'tax_type', v_tr.tax_type, 'source', 'line_override');
  END IF;

  -- (2) Product lines: the canonical cascade (exemption > customer > product > company).
  IF p_product_id IS NOT NULL THEN
    v_res := public.resolve_line_tax_rate(p_business_id, p_product_id, p_contact_id, v_date);
    IF NULLIF(v_res->>'tax_rate_id','') IS NOT NULL THEN
      SELECT * INTO v_tr FROM public.tax_rates tr WHERE tr.id = (v_res->>'tax_rate_id')::uuid;
      IF FOUND AND COALESCE(v_tr.is_compound, false) THEN
        RAISE EXCEPTION
          'compound tax rate % is not supported on a sales line (one tax per line)', v_tr.id
          USING ERRCODE = '0A000';
      END IF;
      RETURN v_res || jsonb_build_object('fixed_amount', COALESCE(v_tr.fixed_amount, 0),
                                         'tax_type', v_tr.tax_type);
    END IF;
    RETURN v_res || jsonb_build_object('fixed_amount', 0, 'tax_type', NULL);
  END IF;

  -- (3) Free-text lines: a typed rate must correspond to a live company rate.
  v_rate := COALESCE(p_requested_rate, 0);
  IF v_rate = 0 THEN
    RETURN jsonb_build_object('rate', 0, 'tax_rate_id', NULL, 'is_inclusive', false,
                              'fixed_amount', 0, 'tax_type', NULL, 'source', 'none');
  END IF;

  SELECT tr.id INTO v_match
    FROM public.tax_rates tr
   WHERE tr.business_id = p_business_id
     AND COALESCE(tr.is_active, true)
     AND NOT COALESCE(tr.is_compound, false)
     AND tr.rate = v_rate
     AND (tr.effective_from IS NULL OR tr.effective_from <= v_date)
     AND (tr.effective_to   IS NULL OR tr.effective_to   >= v_date)
   ORDER BY tr.effective_from DESC NULLS LAST
   LIMIT 1;

  IF v_match IS NULL THEN
    RAISE EXCEPTION
      'tax rate % percent is not configured for this company on %', v_rate, v_date
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_tr FROM public.tax_rates tr WHERE tr.id = v_match;
  RETURN jsonb_build_object(
    'rate', COALESCE(v_tr.rate, 0), 'tax_rate_id', v_tr.id,
    'is_inclusive', COALESCE(v_tr.is_inclusive, false),
    'fixed_amount', COALESCE(v_tr.fixed_amount, 0),
    'tax_type', v_tr.tax_type, 'source', 'free_text_validated');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.resolve_sales_line_tax(uuid, uuid, uuid, date, uuid, numeric)
  TO authenticated, service_role;

-- Line normalisation now taxes as at the DOCUMENT date and records the rate used.
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

  v_qty   := COALESCE((v_row->>'quantity')::numeric, 0);
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
  -- Percentage component plus any per-unit fixed duty/levy.
  v_tax_amt := ROUND(v_taxable * v_rate / 100.0, 2) + ROUND(v_fixed * v_qty, 2);

  NEW := jsonb_populate_record(NEW, jsonb_build_object(
    'tax_rate',    v_rate,
    'tax_rate_id', v_rate_id,
    'tax_amount',  v_tax_amt,
    'line_total',  v_taxable
  ));

  RETURN NEW;
END;
$function$;