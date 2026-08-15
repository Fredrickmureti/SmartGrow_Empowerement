
-- ============================================================================
-- Sales Phase 4 / Milestone 3 — server-authoritative tax and document totals
-- ============================================================================

-- 1. Canonical tax-rate resolution for a Sales line.
CREATE OR REPLACE FUNCTION public.resolve_line_tax_rate(
  p_business_id uuid,
  p_product_id  uuid,
  p_contact_id  uuid,
  p_date        date DEFAULT CURRENT_DATE
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rate_id     uuid;
  v_rate        numeric;
  v_inclusive   boolean;
  v_source      text;
  v_exempt_no   text;
  v_exempt_exp  date;
  v_legacy      numeric;
BEGIN
  IF p_business_id IS NULL THEN
    RETURN jsonb_build_object('rate', 0, 'tax_rate_id', NULL, 'is_inclusive', false, 'source', 'none');
  END IF;

  -- (a) Customer tax exemption wins outright while it is still valid.
  IF p_contact_id IS NOT NULL THEN
    SELECT NULLIF(btrim(c.tax_exemption_number), ''), c.tax_exemption_expiry, c.default_tax_rate_id
      INTO v_exempt_no, v_exempt_exp, v_rate_id
      FROM public.contacts c
     WHERE c.id = p_contact_id;

    IF v_exempt_no IS NOT NULL
       AND (v_exempt_exp IS NULL OR v_exempt_exp >= COALESCE(p_date, CURRENT_DATE)) THEN
      RETURN jsonb_build_object('rate', 0, 'tax_rate_id', NULL, 'is_inclusive', false, 'source', 'customer_exempt');
    END IF;

    -- (b) Customer default rate.
    IF v_rate_id IS NOT NULL THEN
      SELECT tr.rate, COALESCE(tr.is_inclusive, false)
        INTO v_rate, v_inclusive
        FROM public.tax_rates tr
       WHERE tr.id = v_rate_id
         AND COALESCE(tr.is_active, true)
         AND (tr.effective_from IS NULL OR tr.effective_from <= COALESCE(p_date, CURRENT_DATE))
         AND (tr.effective_to   IS NULL OR tr.effective_to   >= COALESCE(p_date, CURRENT_DATE));
      IF v_rate IS NOT NULL THEN
        RETURN jsonb_build_object('rate', v_rate, 'tax_rate_id', v_rate_id,
                                  'is_inclusive', v_inclusive, 'source', 'customer');
      END IF;
      v_rate_id := NULL;
    END IF;
  END IF;

  -- (c) Product tax rate.
  IF p_product_id IS NOT NULL THEN
    SELECT p.tax_rate_id, p.tax_rate INTO v_rate_id, v_legacy
      FROM public.products p
     WHERE p.id = p_product_id;

    IF v_rate_id IS NOT NULL THEN
      SELECT tr.rate, COALESCE(tr.is_inclusive, false)
        INTO v_rate, v_inclusive
        FROM public.tax_rates tr
       WHERE tr.id = v_rate_id
         AND COALESCE(tr.is_active, true)
         AND (tr.effective_from IS NULL OR tr.effective_from <= COALESCE(p_date, CURRENT_DATE))
         AND (tr.effective_to   IS NULL OR tr.effective_to   >= COALESCE(p_date, CURRENT_DATE));
      IF v_rate IS NOT NULL THEN
        RETURN jsonb_build_object('rate', v_rate, 'tax_rate_id', v_rate_id,
                                  'is_inclusive', v_inclusive, 'source', 'product');
      END IF;
    END IF;
  END IF;

  -- (d) Business default rate.
  SELECT tr.id, tr.rate, COALESCE(tr.is_inclusive, false)
    INTO v_rate_id, v_rate, v_inclusive
    FROM public.tax_rates tr
   WHERE tr.business_id = p_business_id
     AND COALESCE(tr.is_default, false)
     AND COALESCE(tr.is_active, true)
     AND (tr.effective_from IS NULL OR tr.effective_from <= COALESCE(p_date, CURRENT_DATE))
     AND (tr.effective_to   IS NULL OR tr.effective_to   >= COALESCE(p_date, CURRENT_DATE))
   ORDER BY tr.effective_from DESC NULLS LAST
   LIMIT 1;
  IF v_rate IS NOT NULL THEN
    RETURN jsonb_build_object('rate', v_rate, 'tax_rate_id', v_rate_id,
                              'is_inclusive', v_inclusive, 'source', 'business_default');
  END IF;

  -- (e) Legacy product scalar, kept only so pre-tax_rates data still taxes.
  IF COALESCE(v_legacy, 0) <> 0 THEN
    RETURN jsonb_build_object('rate', v_legacy, 'tax_rate_id', NULL,
                              'is_inclusive', false, 'source', 'product_legacy');
  END IF;

  RETURN jsonb_build_object('rate', 0, 'tax_rate_id', NULL, 'is_inclusive', false, 'source', 'none');
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_line_tax_rate(uuid, uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_line_tax_rate(uuid, uuid, uuid, date) TO authenticated, service_role;

-- 2. Is the parent document still open for recalculation?
CREATE OR REPLACE FUNCTION public._sales_doc_is_mutable(p_table text, p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_table
    WHEN 'invoices'          THEN COALESCE(p_status, 'draft') IN ('draft', 'sent', 'viewed')
    WHEN 'credit_notes'      THEN COALESCE(p_status, 'draft') = 'draft'
    WHEN 'estimates'         THEN COALESCE(p_status, 'draft') IN ('draft', 'sent', 'viewed')
    WHEN 'sales_orders'      THEN COALESCE(p_status, 'draft') IN ('draft', 'pending', 'confirmed')
    WHEN 'proforma_invoices' THEN COALESCE(p_status, 'draft') IN ('draft', 'sent', 'viewed')
    ELSE true
  END;
$$;

-- 3. Stamp discount / tax / line_total server-side (runs AFTER pricing).
CREATE OR REPLACE FUNCTION public._totals_normalize_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business uuid;
  v_contact  uuid;
  v_status   text;
  v_header   text;
  v_row      jsonb;
  v_tax      jsonb;
  v_rate     numeric := 0;
  v_incl     boolean := false;
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
      SELECT business_id, contact_id, status::text INTO v_business, v_contact, v_status
        FROM public.invoices WHERE id = NEW.invoice_id;
    WHEN 'sales_order_items' THEN
      v_header := 'sales_orders';
      SELECT business_id, contact_id, status::text INTO v_business, v_contact, v_status
        FROM public.sales_orders WHERE id = NEW.sales_order_id;
    WHEN 'estimate_items' THEN
      v_header := 'estimates';
      SELECT business_id, contact_id, status::text INTO v_business, v_contact, v_status
        FROM public.estimates WHERE id = NEW.estimate_id;
    WHEN 'credit_note_items' THEN
      v_header := 'credit_notes';
      SELECT business_id, contact_id, status::text INTO v_business, v_contact, v_status
        FROM public.credit_notes WHERE id = NEW.credit_note_id;
    WHEN 'proforma_invoice_items' THEN
      v_header := 'proforma_invoices';
      SELECT business_id, contact_id, status::text INTO v_business, v_contact, v_status
        FROM public.proforma_invoices WHERE id = NEW.proforma_invoice_id;
    ELSE
      RETURN NEW;
  END CASE;

  -- Never silently rewrite a document that is no longer open.
  IF NOT public._sales_doc_is_mutable(v_header, v_status) THEN
    RETURN NEW;
  END IF;

  v_row := to_jsonb(NEW);

  -- Tax rate: the resolver owns it for product lines; a free-text line keeps
  -- whatever the operator typed (there is no product to resolve against).
  IF NEW.product_id IS NOT NULL THEN
    v_tax  := public.resolve_line_tax_rate(v_business, NEW.product_id, v_contact, CURRENT_DATE);
    v_rate := COALESCE((v_tax->>'rate')::numeric, 0);
    v_incl := COALESCE((v_tax->>'is_inclusive')::boolean, false);
  ELSE
    v_rate := COALESCE((v_row->>'tax_rate')::numeric, 0);
    v_incl := false;
  END IF;

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
  v_tax_amt := ROUND(v_taxable * v_rate / 100.0, 2);

  NEW := jsonb_populate_record(NEW, jsonb_build_object(
    'tax_rate',   v_rate,
    'tax_amount', v_tax_amt,
    'line_total', v_taxable
  ));

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_zzz_totals_invoice_items          ON public.invoice_items;
DROP TRIGGER IF EXISTS trg_zzz_totals_sales_order_items      ON public.sales_order_items;
DROP TRIGGER IF EXISTS trg_zzz_totals_estimate_items         ON public.estimate_items;
DROP TRIGGER IF EXISTS trg_zzz_totals_credit_note_items      ON public.credit_note_items;
DROP TRIGGER IF EXISTS trg_zzz_totals_proforma_invoice_items ON public.proforma_invoice_items;

CREATE TRIGGER trg_zzz_totals_invoice_items
  BEFORE INSERT OR UPDATE ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._totals_normalize_line();
CREATE TRIGGER trg_zzz_totals_sales_order_items
  BEFORE INSERT OR UPDATE ON public.sales_order_items
  FOR EACH ROW EXECUTE FUNCTION public._totals_normalize_line();
CREATE TRIGGER trg_zzz_totals_estimate_items
  BEFORE INSERT OR UPDATE ON public.estimate_items
  FOR EACH ROW EXECUTE FUNCTION public._totals_normalize_line();
CREATE TRIGGER trg_zzz_totals_credit_note_items
  BEFORE INSERT OR UPDATE ON public.credit_note_items
  FOR EACH ROW EXECUTE FUNCTION public._totals_normalize_line();
CREATE TRIGGER trg_zzz_totals_proforma_invoice_items
  BEFORE INSERT OR UPDATE ON public.proforma_invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._totals_normalize_line();

-- 4. Document totals are derived from the lines, never from the browser.
CREATE OR REPLACE FUNCTION public._recalc_document_totals()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_header  text;
  v_fk      text;
  v_id      uuid;
  v_row     jsonb;
  v_status  text;
  v_has_disc boolean;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'invoice_items'          THEN v_header := 'invoices';          v_fk := 'invoice_id';
    WHEN 'sales_order_items'      THEN v_header := 'sales_orders';      v_fk := 'sales_order_id';
    WHEN 'estimate_items'         THEN v_header := 'estimates';         v_fk := 'estimate_id';
    WHEN 'credit_note_items'      THEN v_header := 'credit_notes';      v_fk := 'credit_note_id';
    WHEN 'proforma_invoice_items' THEN v_header := 'proforma_invoices'; v_fk := 'proforma_invoice_id';
    ELSE RETURN NULL;
  END CASE;

  v_row := to_jsonb(COALESCE(NEW, OLD));
  v_id  := (v_row->>v_fk)::uuid;
  IF v_id IS NULL THEN RETURN NULL; END IF;

  EXECUTE format('SELECT status::text FROM public.%I WHERE id = $1', v_header)
    INTO v_status USING v_id;
  IF NOT public._sales_doc_is_mutable(v_header, v_status) THEN
    RETURN NULL;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = v_header AND column_name = 'discount_amount'
  ) INTO v_has_disc;

  PERFORM set_config('sales.totals_recalc', '1', true);

  EXECUTE format($f$
    UPDATE public.%1$I h
       SET subtotal   = t.subtotal,
           tax_amount = t.tax_amount,
           total      = ROUND(t.subtotal + t.tax_amount - %2$s, 2)
      FROM (
        SELECT COALESCE(ROUND(SUM(line_total), 2), 0)  AS subtotal,
               COALESCE(ROUND(SUM(tax_amount), 2), 0)  AS tax_amount
          FROM public.%3$I WHERE %4$I = $1
      ) t
     WHERE h.id = $1
  $f$, v_header, CASE WHEN v_has_disc THEN 'COALESCE(h.discount_amount, 0)' ELSE '0' END,
       TG_TABLE_NAME, v_fk)
  USING v_id;

  PERFORM set_config('sales.totals_recalc', '0', true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_recalc_totals_invoice_items          ON public.invoice_items;
DROP TRIGGER IF EXISTS trg_recalc_totals_sales_order_items      ON public.sales_order_items;
DROP TRIGGER IF EXISTS trg_recalc_totals_estimate_items         ON public.estimate_items;
DROP TRIGGER IF EXISTS trg_recalc_totals_credit_note_items      ON public.credit_note_items;
DROP TRIGGER IF EXISTS trg_recalc_totals_proforma_invoice_items ON public.proforma_invoice_items;

CREATE TRIGGER trg_recalc_totals_invoice_items
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._recalc_document_totals();
CREATE TRIGGER trg_recalc_totals_sales_order_items
  AFTER INSERT OR UPDATE OR DELETE ON public.sales_order_items
  FOR EACH ROW EXECUTE FUNCTION public._recalc_document_totals();
CREATE TRIGGER trg_recalc_totals_estimate_items
  AFTER INSERT OR UPDATE OR DELETE ON public.estimate_items
  FOR EACH ROW EXECUTE FUNCTION public._recalc_document_totals();
CREATE TRIGGER trg_recalc_totals_credit_note_items
  AFTER INSERT OR UPDATE OR DELETE ON public.credit_note_items
  FOR EACH ROW EXECUTE FUNCTION public._recalc_document_totals();
CREATE TRIGGER trg_recalc_totals_proforma_invoice_items
  AFTER INSERT OR UPDATE OR DELETE ON public.proforma_invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._recalc_document_totals();

-- 5. Header guard: a client total that disagrees with the lines is corrected.
CREATE OR REPLACE FUNCTION public._sales_header_totals_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_line_tbl text;
  v_fk       text;
  v_sub      numeric;
  v_tax      numeric;
  v_disc     numeric := 0;
  v_row      jsonb;
BEGIN
  IF COALESCE(current_setting('sales.totals_recalc', true), '0') = '1' THEN
    RETURN NEW;
  END IF;
  IF NOT public._sales_doc_is_mutable(TG_TABLE_NAME, NEW.status::text) THEN
    RETURN NEW;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'invoices'          THEN v_line_tbl := 'invoice_items';          v_fk := 'invoice_id';
    WHEN 'sales_orders'      THEN v_line_tbl := 'sales_order_items';      v_fk := 'sales_order_id';
    WHEN 'estimates'         THEN v_line_tbl := 'estimate_items';         v_fk := 'estimate_id';
    WHEN 'credit_notes'      THEN v_line_tbl := 'credit_note_items';      v_fk := 'credit_note_id';
    WHEN 'proforma_invoices' THEN v_line_tbl := 'proforma_invoice_items'; v_fk := 'proforma_invoice_id';
    ELSE RETURN NEW;
  END CASE;

  EXECUTE format(
    'SELECT COALESCE(ROUND(SUM(line_total),2),0), COALESCE(ROUND(SUM(tax_amount),2),0)
       FROM public.%I WHERE %I = $1', v_line_tbl, v_fk)
    INTO v_sub, v_tax USING NEW.id;

  -- No lines yet (header being created) → nothing to derive from.
  IF v_sub = 0 AND v_tax = 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=v_line_tbl
    ) THEN RETURN NEW; END IF;
  END IF;

  v_row := to_jsonb(NEW);
  IF v_row ? 'discount_amount' THEN
    v_disc := COALESCE((v_row->>'discount_amount')::numeric, 0);
  END IF;

  IF TG_OP = 'INSERT' AND v_sub = 0 AND v_tax = 0 THEN
    RETURN NEW;
  END IF;

  NEW := jsonb_populate_record(NEW, jsonb_build_object(
    'subtotal',   v_sub,
    'tax_amount', v_tax,
    'total',      ROUND(v_sub + v_tax - v_disc, 2)
  ));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_zzz_header_totals_invoices          ON public.invoices;
DROP TRIGGER IF EXISTS trg_zzz_header_totals_sales_orders      ON public.sales_orders;
DROP TRIGGER IF EXISTS trg_zzz_header_totals_estimates         ON public.estimates;
DROP TRIGGER IF EXISTS trg_zzz_header_totals_credit_notes      ON public.credit_notes;
DROP TRIGGER IF EXISTS trg_zzz_header_totals_proforma_invoices ON public.proforma_invoices;

CREATE TRIGGER trg_zzz_header_totals_invoices
  BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public._sales_header_totals_guard();
CREATE TRIGGER trg_zzz_header_totals_sales_orders
  BEFORE INSERT OR UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public._sales_header_totals_guard();
CREATE TRIGGER trg_zzz_header_totals_estimates
  BEFORE INSERT OR UPDATE ON public.estimates
  FOR EACH ROW EXECUTE FUNCTION public._sales_header_totals_guard();
CREATE TRIGGER trg_zzz_header_totals_credit_notes
  BEFORE INSERT OR UPDATE ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public._sales_header_totals_guard();
CREATE TRIGGER trg_zzz_header_totals_proforma_invoices
  BEFORE INSERT OR UPDATE ON public.proforma_invoices
  FOR EACH ROW EXECUTE FUNCTION public._sales_header_totals_guard();
