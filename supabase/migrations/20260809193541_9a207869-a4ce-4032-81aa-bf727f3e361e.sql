-- ============================================================
-- Phase 8.1 — snapshot the invoice line's tax basis
-- ============================================================
ALTER TABLE public.sales_return_items
  ADD COLUMN IF NOT EXISTS source_tax_rate numeric,
  ADD COLUMN IF NOT EXISTS source_tax_amount numeric,
  ADD COLUMN IF NOT EXISTS source_discount_percent numeric,
  ADD COLUMN IF NOT EXISTS etims_tax_code text,
  ADD COLUMN IF NOT EXISTS etims_classification_code text,
  ADD COLUMN IF NOT EXISTS tax_basis_source text;

ALTER TABLE public.credit_note_items
  ADD COLUMN IF NOT EXISTS etims_tax_code text,
  ADD COLUMN IF NOT EXISTS etims_classification_code text;

CREATE OR REPLACE FUNCTION public.resolve_sales_return_line_tax(
  _invoice_item_id uuid,
  _qty numeric
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_ii public.invoice_items%ROWTYPE;
  v_qty numeric := ABS(COALESCE(_qty, 0));
  v_prop numeric;
  v_net_unit numeric;
  v_net numeric;
  v_tax numeric;
BEGIN
  IF _invoice_item_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_ii FROM public.invoice_items WHERE id = _invoice_item_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Proportion of the invoiced line being returned. Tax comes from the line's
  -- STORED tax_amount so the historic rounding of the sale is honoured.
  IF COALESCE(v_ii.quantity, 0) = 0 THEN
    v_prop := 0;
  ELSE
    v_prop := v_qty / ABS(v_ii.quantity);
  END IF;

  v_net_unit := ROUND(COALESCE(v_ii.unit_price, 0)
                      * (1 - COALESCE(v_ii.discount_percent, 0) / 100.0), 6);
  v_net := ROUND(v_net_unit * v_qty, 6);
  v_tax := ROUND(COALESCE(v_ii.tax_amount, 0) * v_prop, 6);

  RETURN jsonb_build_object(
    'invoice_item_id', v_ii.id,
    'proportion', v_prop,
    'unit_price', COALESCE(v_ii.unit_price, 0),
    'net_unit_price', v_net_unit,
    'net_amount', v_net,
    'discount_percent', COALESCE(v_ii.discount_percent, 0),
    'tax_rate', COALESCE(v_ii.tax_rate, 0),
    'tax_amount', v_tax,
    'source_tax_amount', COALESCE(v_ii.tax_amount, 0),
    'etims_tax_code', v_ii.etims_tax_code,
    'etims_classification_code', v_ii.etims_classification_code
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.resolve_sales_return_line_tax(uuid, numeric) TO authenticated;

-- Best-effort backfill of provenance for existing invoice-sourced lines.
UPDATE public.sales_return_items sri
   SET source_tax_rate = COALESCE(sri.source_tax_rate, ii.tax_rate),
       source_tax_amount = COALESCE(sri.source_tax_amount, ii.tax_amount),
       source_discount_percent = COALESCE(sri.source_discount_percent, ii.discount_percent),
       etims_tax_code = COALESCE(sri.etims_tax_code, ii.etims_tax_code),
       etims_classification_code = COALESCE(sri.etims_classification_code, ii.etims_classification_code),
       tax_basis_source = COALESCE(sri.tax_basis_source, 'backfilled_invoice_line')
  FROM public.invoice_items ii
 WHERE ii.id = sri.invoice_item_id
   AND sri.tax_basis_source IS NULL;

UPDATE public.sales_return_items
   SET tax_basis_source = 'manual'
 WHERE tax_basis_source IS NULL;

-- ============================================================
-- Phase 8.1 — creation resolves tax server-side
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_sales_return_atomic(_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_org uuid := (_payload->>'organization_id')::uuid;
  v_business uuid := (_payload->>'business_id')::uuid;
  v_branch uuid := NULLIF(_payload->>'branch_id','')::uuid;
  v_crid text := NULLIF(_payload->>'client_request_id','');
  v_items jsonb := COALESCE(_payload->'items', '[]'::jsonb);
  v_existing public.sales_returns%ROWTYPE;
  v_id uuid;
  v_subtotal numeric := 0;
  v_tax numeric := 0;
  v_total numeric := 0;
  v_number text;
  v_rounded_tax numeric;
  v_delta numeric;
  v_biggest uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;
  IF v_business IS NULL OR NOT public.user_can_access_business(auth.uid(), v_business) THEN
    RAISE EXCEPTION 'Access denied for business %', v_business USING ERRCODE = '42501';
  END IF;
  IF jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'a sales return needs at least one line' USING ERRCODE = '22023';
  END IF;

  -- Replay safety: the same request returns the same document.
  IF v_crid IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.sales_returns
     WHERE organization_id = v_org AND client_request_id = v_crid;
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'id', v_existing.id,
        'return_number', v_existing.return_number, 'created', false);
    END IF;
  END IF;

  INSERT INTO public.sales_returns(
    organization_id, business_id, branch_id, contact_id, return_number, return_date,
    status, invoice_id, reason, currency, subtotal, tax_amount, total,
    refund_method, notes, created_by, client_request_id
  ) VALUES (
    v_org, v_business, v_branch,
    NULLIF(_payload->>'contact_id','')::uuid,
    NULL,
    COALESCE(NULLIF(_payload->>'return_date','')::date, CURRENT_DATE),
    'pending',
    NULLIF(_payload->>'invoice_id','')::uuid,
    COALESCE(NULLIF(_payload->>'reason',''), 'Customer return'),
    COALESCE(NULLIF(_payload->>'currency',''),
             (SELECT base_currency FROM public.businesses WHERE id = v_business)),
    0, 0, 0,
    NULLIF(_payload->>'refund_method',''),
    NULLIF(_payload->>'notes',''),
    auth.uid(), v_crid
  ) RETURNING id, return_number INTO v_id, v_number;

  -- Lines: tax for an invoice-sourced line is ALWAYS the tax the original
  -- invoice line charged, never the product's current setting.
  INSERT INTO public.sales_return_items(
    sales_return_id, product_id, invoice_item_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, return_reason, condition,
    lot_number, serial_number, sort_order,
    source_tax_rate, source_tax_amount, source_discount_percent,
    etims_tax_code, etims_classification_code, tax_basis_source
  )
  SELECT
    v_id,
    NULLIF(it->>'product_id','')::uuid,
    NULLIF(it->>'invoice_item_id','')::uuid,
    COALESCE(NULLIF(it->>'description',''), 'Returned item'),
    (it->>'quantity')::numeric,
    COALESCE((b->>'unit_price')::numeric, (it->>'unit_price')::numeric),
    COALESCE((b->>'tax_rate')::numeric, NULLIF(it->>'tax_rate','')::numeric, 0),
    COALESCE((b->>'tax_amount')::numeric, NULLIF(it->>'tax_amount','')::numeric, 0),
    COALESCE((b->>'net_amount')::numeric,
             ROUND((it->>'quantity')::numeric * (it->>'unit_price')::numeric, 6)),
    NULLIF(it->>'return_reason',''),
    COALESCE(NULLIF(it->>'condition',''), 'good'),
    NULLIF(it->>'lot_number',''),
    NULLIF(it->>'serial_number',''),
    (ord - 1)::integer,
    (b->>'tax_rate')::numeric,
    (b->>'source_tax_amount')::numeric,
    (b->>'discount_percent')::numeric,
    b->>'etims_tax_code',
    b->>'etims_classification_code',
    CASE WHEN b IS NULL THEN 'manual' ELSE 'invoice_line' END
  FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(it, ord)
  CROSS JOIN LATERAL (
    SELECT public.resolve_sales_return_line_tax(
      NULLIF(it->>'invoice_item_id','')::uuid, (it->>'quantity')::numeric) AS b
  ) r;

  -- Document-level rounding: settle tax to 2dp once, on the largest tax line,
  -- so line rounding never drifts the output-tax control account.
  SELECT COALESCE(SUM(line_total), 0), COALESCE(SUM(tax_amount), 0)
    INTO v_subtotal, v_tax
    FROM public.sales_return_items WHERE sales_return_id = v_id;

  v_rounded_tax := ROUND(v_tax, 2);
  v_delta := v_rounded_tax - v_tax;
  IF v_delta <> 0 THEN
    SELECT id INTO v_biggest FROM public.sales_return_items
     WHERE sales_return_id = v_id
     ORDER BY ABS(COALESCE(tax_amount, 0)) DESC, sort_order NULLS LAST, id
     LIMIT 1;
    IF v_biggest IS NOT NULL THEN
      UPDATE public.sales_return_items
         SET tax_amount = COALESCE(tax_amount, 0) + v_delta
       WHERE id = v_biggest;
    END IF;
  END IF;

  v_subtotal := ROUND(v_subtotal, 2);
  v_tax := v_rounded_tax;
  v_total := v_subtotal + v_tax;

  UPDATE public.sales_returns
     SET subtotal = v_subtotal, tax_amount = v_tax, total = v_total
   WHERE id = v_id;

  RETURN jsonb_build_object('success', true, 'id', v_id,
    'return_number', v_number, 'created', true,
    'subtotal', v_subtotal, 'tax_amount', v_tax, 'total', v_total);
END;
$fn$;

-- ============================================================
-- Phase 8.2 — carry the fiscal tax codes into the credit note
-- ============================================================
-- Surgical edit of approve_sales_return_atomic: only the credit_note_items
-- projection changes; every other line of the Phase 1-6 body is preserved.
DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'approve_sales_return_atomic';

  v_old := 'INSERT INTO public.credit_note_items(
    credit_note_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, sort_order,
    lot_number, serial_number
  )
  SELECT
    v_cn_id, sri.product_id, sri.description, sri.quantity, sri.unit_price,
    COALESCE(sri.tax_rate,0), COALESCE(sri.tax_amount,0), sri.line_total, sri.sort_order,
    sri.lot_number, sri.serial_number';

  v_new := 'INSERT INTO public.credit_note_items(
    credit_note_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, sort_order,
    lot_number, serial_number, etims_tax_code, etims_classification_code
  )
  SELECT
    v_cn_id, sri.product_id, sri.description, sri.quantity, sri.unit_price,
    COALESCE(sri.tax_rate,0), COALESCE(sri.tax_amount,0), sri.line_total, sri.sort_order,
    sri.lot_number, sri.serial_number, sri.etims_tax_code, sri.etims_classification_code';

  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'approve_sales_return_atomic credit_note_items projection not found — refusing to patch blindly';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END
$do$;

-- create_credit_note_atomic: accept and persist the codes when supplied.
DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_credit_note_atomic';

  v_old := 'packaging_id, display_uom_id, display_quantity, lot_number, serial_number
  )';
  v_new := 'packaging_id, display_uom_id, display_quantity, lot_number, serial_number,
    etims_tax_code, etims_classification_code
  )';
  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'create_credit_note_atomic column list not found';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := '         NULLIF(i->>''lot_number'',''''),
         NULLIF(i->>''serial_number'','''')';
  v_new := '         NULLIF(i->>''lot_number'',''''),
         NULLIF(i->>''serial_number'',''''),
         NULLIF(i->>''etims_tax_code'',''''),
         NULLIF(i->>''etims_classification_code'','''')';
  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'create_credit_note_atomic select list not found';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  EXECUTE v_def;
END
$do$;

-- ============================================================
-- Phase 8.3 — one fiscal document per economic reversal
-- ============================================================
-- The sales return is an internal document; the credit note is the fiscal
-- artefact. Two enqueues for one reversal transmitted the same event twice.
DROP TRIGGER IF EXISTS trg_sales_return_fiscal_enqueue ON public.sales_returns;
DROP FUNCTION IF EXISTS public.tg_sales_return_fiscal_enqueue();

ALTER TABLE public.fiscal_transmissions
  ADD COLUMN IF NOT EXISTS original_transmission_id uuid REFERENCES public.fiscal_transmissions(id),
  ADD COLUMN IF NOT EXISTS original_fiscal_number text;

CREATE OR REPLACE FUNCTION public.tg_fiscal_transmission_link_original()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_invoice_id uuid;
  v_orig public.fiscal_transmissions%ROWTYPE;
BEGIN
  IF NEW.original_transmission_id IS NOT NULL
     OR NEW.source_doc_type <> 'credit_notes' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(invoice_id, original_invoice_id) INTO v_invoice_id
    FROM public.credit_notes WHERE id = NEW.source_doc_id;

  IF v_invoice_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_orig
    FROM public.fiscal_transmissions
   WHERE source_doc_type = 'invoices'
     AND source_doc_id = v_invoice_id
     AND fiscal_number IS NOT NULL
   ORDER BY transmitted_at DESC NULLS LAST, created_at DESC
   LIMIT 1;

  IF v_orig.id IS NOT NULL THEN
    NEW.original_transmission_id := v_orig.id;
    NEW.original_fiscal_number := v_orig.fiscal_number;
    NEW.request_payload := COALESCE(NEW.request_payload, '{}'::jsonb)
      || jsonb_build_object(
           'original_transmission_id', v_orig.id,
           'original_fiscal_number', v_orig.fiscal_number,
           'original_invoice_id', v_invoice_id);
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_fiscal_transmission_link_original ON public.fiscal_transmissions;
CREATE TRIGGER trg_fiscal_transmission_link_original
  BEFORE INSERT ON public.fiscal_transmissions
  FOR EACH ROW EXECUTE FUNCTION public.tg_fiscal_transmission_link_original();