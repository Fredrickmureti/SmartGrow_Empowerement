-- 1. Durable provenance on credit note lines
ALTER TABLE public.credit_note_items
  ADD COLUMN IF NOT EXISTS invoice_item_id uuid REFERENCES public.invoice_items(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_unit_price numeric,
  ADD COLUMN IF NOT EXISTS source_discount_percent numeric,
  ADD COLUMN IF NOT EXISTS source_tax_rate numeric,
  ADD COLUMN IF NOT EXISTS source_currency text;

CREATE INDEX IF NOT EXISTS idx_credit_note_items_invoice_item
  ON public.credit_note_items (invoice_item_id) WHERE invoice_item_id IS NOT NULL;

-- 2. Idempotency key on credit notes
ALTER TABLE public.credit_notes
  ADD COLUMN IF NOT EXISTS client_request_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_notes_client_request
  ON public.credit_notes (business_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

-- 3. Creditable-quantity ledger (credit-side analogue of v_sales_returnable_qty)
CREATE OR REPLACE VIEW public.v_invoice_creditable_qty
WITH (security_invoker = true) AS
SELECT
  ii.id                       AS invoice_item_id,
  ii.invoice_id,
  ii.business_id,
  ii.product_id,
  ii.description,
  ii.quantity                 AS invoiced_qty,
  ii.unit_price,
  COALESCE(ii.discount_percent, 0) AS discount_percent,
  ROUND(ii.unit_price * (1 - COALESCE(ii.discount_percent, 0) / 100.0), 6) AS net_unit_price,
  COALESCE(ii.tax_rate, 0)    AS tax_rate,
  COALESCE(c.credited_qty, 0) AS credited_qty,
  GREATEST(ii.quantity - COALESCE(c.credited_qty, 0), 0) AS remaining_qty,
  ROUND(
    GREATEST(ii.quantity - COALESCE(c.credited_qty, 0), 0)
    * ii.unit_price * (1 - COALESCE(ii.discount_percent, 0) / 100.0), 2) AS remaining_net_amount
FROM public.invoice_items ii
LEFT JOIN LATERAL (
  SELECT SUM(cni.quantity) AS credited_qty
  FROM public.credit_note_items cni
  JOIN public.credit_notes cn ON cn.id = cni.credit_note_id
  WHERE cni.invoice_item_id = ii.id
    AND cn.status <> 'void'::credit_note_status
) c ON TRUE;

GRANT SELECT ON public.v_invoice_creditable_qty TO authenticated;
GRANT SELECT ON public.v_invoice_creditable_qty TO service_role;

-- 4. Shared line resolver: server-authoritative money for one credit note line
CREATE OR REPLACE FUNCTION public._resolve_credit_note_line(
  _item jsonb,
  _invoice_id uuid,
  _exclude_credit_note_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_item_id uuid;
  v_qty numeric;
  v_src RECORD;
  v_already numeric;
  v_remaining numeric;
  v_net_unit numeric;
  v_line_total numeric;
  v_tax numeric;
  v_rate numeric;
  v_price numeric;
BEGIN
  v_item_id := NULLIF(_item->>'invoice_item_id', '')::uuid;
  v_qty     := COALESCE((_item->>'quantity')::numeric, 0);

  IF v_qty <= 0 THEN
    RAISE EXCEPTION 'Credit note line quantity must be greater than zero';
  END IF;

  IF v_item_id IS NULL THEN
    -- Off-invoice adjustment: still recomputed server-side, never trusted verbatim.
    v_price := COALESCE((_item->>'unit_price')::numeric, 0);
    v_rate  := COALESCE((_item->>'tax_rate')::numeric, 0);
    IF v_price < 0 THEN
      RAISE EXCEPTION 'Credit note line price cannot be negative';
    END IF;
    v_line_total := ROUND(v_qty * v_price, 2);
    v_tax        := ROUND(v_line_total * v_rate / 100.0, 2);
    RETURN jsonb_build_object(
      'invoice_item_id', NULL,
      'product_id', NULLIF(_item->>'product_id','')::uuid,
      'description', COALESCE(NULLIF(_item->>'description',''), 'Credit adjustment'),
      'quantity', v_qty,
      'unit_price', v_price,
      'tax_rate', v_rate,
      'tax_amount', v_tax,
      'line_total', v_line_total,
      'source_unit_price', NULL,
      'source_discount_percent', NULL,
      'source_tax_rate', NULL
    );
  END IF;

  IF _invoice_id IS NULL THEN
    RAISE EXCEPTION 'An invoice-referenced credit line requires the credit note to reference an invoice';
  END IF;

  SELECT ii.id, ii.invoice_id, ii.product_id, ii.description, ii.quantity,
         ii.unit_price, COALESCE(ii.discount_percent,0) AS discount_percent,
         COALESCE(ii.tax_rate,0) AS tax_rate, COALESCE(ii.tax_amount,0) AS tax_amount,
         ii.packaging_id, ii.display_uom_id, ii.uom_snapshot,
         ii.etims_tax_code, ii.etims_classification_code
    INTO v_src
  FROM public.invoice_items ii
  WHERE ii.id = v_item_id;

  IF NOT FOUND OR v_src.invoice_id <> _invoice_id THEN
    RAISE EXCEPTION 'Invoice line % does not belong to invoice %', v_item_id, _invoice_id
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(SUM(cni.quantity), 0) INTO v_already
  FROM public.credit_note_items cni
  JOIN public.credit_notes cn ON cn.id = cni.credit_note_id
  WHERE cni.invoice_item_id = v_item_id
    AND cn.status <> 'void'::credit_note_status
    AND (_exclude_credit_note_id IS NULL OR cn.id <> _exclude_credit_note_id);

  v_remaining := v_src.quantity - v_already;
  IF v_qty > v_remaining + 0.000001 THEN
    RAISE EXCEPTION 'Cannot credit % of "%": only % remain creditable (invoiced %, already credited %)',
      v_qty, v_src.description, GREATEST(v_remaining,0), v_src.quantity, v_already;
  END IF;

  -- Historical fidelity: price, discount and tax come from the invoice line,
  -- never from today's product configuration or the client payload.
  v_net_unit   := ROUND(v_src.unit_price * (1 - v_src.discount_percent / 100.0), 6);
  v_line_total := ROUND(v_qty * v_net_unit, 2);
  IF v_src.quantity > 0 AND v_src.tax_amount <> 0 THEN
    v_tax := ROUND(v_src.tax_amount * (v_qty / v_src.quantity), 2);
  ELSE
    v_tax := ROUND(v_line_total * v_src.tax_rate / 100.0, 2);
  END IF;

  RETURN jsonb_build_object(
    'invoice_item_id', v_item_id,
    'product_id', v_src.product_id,
    'description', v_src.description,
    'quantity', v_qty,
    'unit_price', v_net_unit,
    'tax_rate', v_src.tax_rate,
    'tax_amount', v_tax,
    'line_total', v_line_total,
    'source_unit_price', v_src.unit_price,
    'source_discount_percent', v_src.discount_percent,
    'source_tax_rate', v_src.tax_rate,
    'packaging_id', v_src.packaging_id,
    'display_uom_id', v_src.display_uom_id,
    'etims_tax_code', v_src.etims_tax_code,
    'etims_classification_code', v_src.etims_classification_code
  );
END;
$function$;

-- 5. Server-authoritative creation
CREATE OR REPLACE FUNCTION public.create_credit_note_atomic(_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id uuid;
  v_business_id uuid;
  v_branch_id uuid;
  v_contact_id uuid;
  v_invoice_id uuid;
  v_issue_date date;
  v_reason text;
  v_notes text;
  v_items jsonb;
  v_source_return_id uuid;
  v_issue boolean;
  v_request_id text;
  v_cn_id uuid;
  v_number text;
  v_subtotal numeric := 0;
  v_tax numeric := 0;
  v_currency text;
  v_branch uuid;
  v_org uuid;
  v_inv RECORD;
  v_item jsonb;
  v_resolved jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_existing RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  IF _payload IS NULL OR jsonb_typeof(_payload) <> 'object' THEN
    RAISE EXCEPTION 'Credit note request must be a JSON object';
  END IF;

  v_org_id           := NULLIF(_payload->>'organization_id', '')::uuid;
  v_business_id      := NULLIF(_payload->>'business_id', '')::uuid;
  v_branch_id        := NULLIF(_payload->>'branch_id', '')::uuid;
  v_contact_id       := NULLIF(_payload->>'contact_id', '')::uuid;
  v_invoice_id       := NULLIF(_payload->>'invoice_id', '')::uuid;
  v_issue_date       := NULLIF(_payload->>'issue_date', '')::date;
  v_reason           := NULLIF(_payload->>'reason', '');
  v_notes            := NULLIF(_payload->>'notes', '');
  v_items            := _payload->'items';
  v_source_return_id := NULLIF(_payload->>'source_return_id', '')::uuid;
  v_issue            := COALESCE((_payload->>'issue')::boolean, false);
  v_request_id       := NULLIF(_payload->>'client_request_id', '');

  IF v_business_id IS NULL OR NOT public.user_can_access_business(auth.uid(), v_business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_business_id USING ERRCODE = '42501';
  END IF;
  IF v_contact_id IS NULL THEN
    RAISE EXCEPTION 'A credit note requires a customer';
  END IF;
  IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'A credit note requires at least one line';
  END IF;

  -- Idempotency: the same request key never creates a second economic document.
  IF v_request_id IS NOT NULL THEN
    SELECT id, credit_note_number INTO v_existing
    FROM public.credit_notes
    WHERE business_id = v_business_id AND client_request_id = v_request_id;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'credit_note_id', v_existing.id,
        'credit_note_number', v_existing.credit_note_number,
        'idempotent_replay', true);
    END IF;
  END IF;

  SELECT COALESCE(v_org_id, organization_id), COALESCE(NULLIF(base_currency, ''), 'KES')
    INTO v_org, v_currency
  FROM public.businesses WHERE id = v_business_id;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Unable to resolve organization for business %', v_business_id;
  END IF;

  -- Invoice authorisation + coherence. SECURITY DEFINER bypasses RLS, so the
  -- caller's right to this invoice must be proven explicitly.
  IF v_invoice_id IS NOT NULL THEN
    SELECT id, business_id, contact_id, branch_id, currency
      INTO v_inv
    FROM public.invoices
    WHERE id = v_invoice_id
    FOR UPDATE;

    IF NOT FOUND OR v_inv.business_id IS DISTINCT FROM v_business_id THEN
      RAISE EXCEPTION 'Invoice % is not available to this business', v_invoice_id USING ERRCODE = '42501';
    END IF;
    IF v_inv.contact_id IS DISTINCT FROM v_contact_id THEN
      RAISE EXCEPTION 'Invoice belongs to a different customer' USING ERRCODE = '42501';
    END IF;
    v_currency := COALESCE(NULLIF(v_inv.currency, ''), v_currency);
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items)
  LOOP
    v_resolved := public._resolve_credit_note_line(v_item, v_invoice_id, NULL);
    v_lines := v_lines || jsonb_build_array(v_resolved);
    v_subtotal := v_subtotal + (v_resolved->>'line_total')::numeric;
    v_tax := v_tax + (v_resolved->>'tax_amount')::numeric;
  END LOOP;

  IF v_subtotal + v_tax <= 0 THEN
    RAISE EXCEPTION 'Credit note total must be positive';
  END IF;

  v_branch := COALESCE(v_inv.branch_id, v_branch_id);
  v_number := public.get_next_credit_note_number(v_org, v_business_id, v_branch);

  INSERT INTO public.credit_notes (
    organization_id, business_id, branch_id, contact_id, invoice_id, original_invoice_id,
    credit_note_number, status, issue_date, subtotal, tax_amount, total,
    currency, reason, notes, source_return_id, created_by, client_request_id
  ) VALUES (
    v_org, v_business_id, v_branch, v_contact_id, v_invoice_id, v_invoice_id,
    v_number, 'draft'::credit_note_status, COALESCE(v_issue_date, CURRENT_DATE),
    v_subtotal, v_tax, v_subtotal + v_tax,
    COALESCE(v_currency, 'KES'), v_reason, v_notes, v_source_return_id, auth.uid(), v_request_id
  ) RETURNING id INTO v_cn_id;

  INSERT INTO public.credit_note_items (
    credit_note_id, invoice_item_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, sort_order,
    source_unit_price, source_discount_percent, source_tax_rate, source_currency,
    packaging_id, display_uom_id, etims_tax_code, etims_classification_code
  )
  SELECT v_cn_id,
         NULLIF(i->>'invoice_item_id','')::uuid,
         NULLIF(i->>'product_id','')::uuid,
         i->>'description',
         (i->>'quantity')::numeric,
         (i->>'unit_price')::numeric,
         (i->>'tax_rate')::numeric,
         (i->>'tax_amount')::numeric,
         (i->>'line_total')::numeric,
         (ord - 1)::integer,
         NULLIF(i->>'source_unit_price','')::numeric,
         NULLIF(i->>'source_discount_percent','')::numeric,
         NULLIF(i->>'source_tax_rate','')::numeric,
         COALESCE(v_currency, 'KES'),
         NULLIF(i->>'packaging_id','')::uuid,
         NULLIF(i->>'display_uom_id','')::uuid,
         NULLIF(i->>'etims_tax_code',''),
         NULLIF(i->>'etims_classification_code','')
  FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS t(i, ord);

  IF v_issue THEN
    PERFORM public.issue_credit_note_atomic(v_cn_id);
  END IF;

  RETURN jsonb_build_object('credit_note_id', v_cn_id, 'credit_note_number', v_number);
END;
$function$;

-- 6. Server-authoritative editing (drafts only)
CREATE OR REPLACE FUNCTION public.update_credit_note_atomic(_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cn_id uuid;
  v_cn RECORD;
  v_items jsonb;
  v_item jsonb;
  v_resolved jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_subtotal numeric := 0;
  v_tax numeric := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  v_cn_id := NULLIF(_payload->>'credit_note_id', '')::uuid;
  IF v_cn_id IS NULL THEN
    RAISE EXCEPTION 'credit_note_id is required';
  END IF;

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = v_cn_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found' USING ERRCODE = '42501';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_cn.business_id) THEN
    RAISE EXCEPTION 'Access denied for this credit note' USING ERRCODE = '42501';
  END IF;
  IF v_cn.status <> 'draft'::credit_note_status THEN
    RAISE EXCEPTION 'Only draft credit notes can be edited (this one is %)', v_cn.status;
  END IF;

  v_items := _payload->'items';

  IF v_items IS NOT NULL AND jsonb_typeof(v_items) = 'array' THEN
    IF jsonb_array_length(v_items) = 0 THEN
      RAISE EXCEPTION 'A credit note requires at least one line';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_items)
    LOOP
      v_resolved := public._resolve_credit_note_line(v_item, v_cn.invoice_id, v_cn_id);
      v_lines := v_lines || jsonb_build_array(v_resolved);
      v_subtotal := v_subtotal + (v_resolved->>'line_total')::numeric;
      v_tax := v_tax + (v_resolved->>'tax_amount')::numeric;
    END LOOP;

    IF v_subtotal + v_tax <= 0 THEN
      RAISE EXCEPTION 'Credit note total must be positive';
    END IF;

    DELETE FROM public.credit_note_items WHERE credit_note_id = v_cn_id;

    INSERT INTO public.credit_note_items (
      credit_note_id, invoice_item_id, product_id, description, quantity, unit_price,
      tax_rate, tax_amount, line_total, sort_order,
      source_unit_price, source_discount_percent, source_tax_rate, source_currency,
      packaging_id, display_uom_id, etims_tax_code, etims_classification_code
    )
    SELECT v_cn_id,
           NULLIF(i->>'invoice_item_id','')::uuid,
           NULLIF(i->>'product_id','')::uuid,
           i->>'description',
           (i->>'quantity')::numeric,
           (i->>'unit_price')::numeric,
           (i->>'tax_rate')::numeric,
           (i->>'tax_amount')::numeric,
           (i->>'line_total')::numeric,
           (ord - 1)::integer,
           NULLIF(i->>'source_unit_price','')::numeric,
           NULLIF(i->>'source_discount_percent','')::numeric,
           NULLIF(i->>'source_tax_rate','')::numeric,
           v_cn.currency,
           NULLIF(i->>'packaging_id','')::uuid,
           NULLIF(i->>'display_uom_id','')::uuid,
           NULLIF(i->>'etims_tax_code',''),
           NULLIF(i->>'etims_classification_code','')
    FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS t(i, ord);

    UPDATE public.credit_notes
       SET subtotal = v_subtotal,
           tax_amount = v_tax,
           total = v_subtotal + v_tax,
           updated_at = now()
     WHERE id = v_cn_id;
  END IF;

  UPDATE public.credit_notes
     SET reason = COALESCE(NULLIF(_payload->>'reason',''), reason),
         notes = CASE WHEN _payload ? 'notes' THEN NULLIF(_payload->>'notes','') ELSE notes END,
         issue_date = COALESCE(NULLIF(_payload->>'issue_date','')::date, issue_date),
         updated_at = now()
   WHERE id = v_cn_id;

  RETURN jsonb_build_object('credit_note_id', v_cn_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.update_credit_note_atomic(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_credit_note_atomic(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_credit_note_atomic(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public._resolve_credit_note_line(jsonb, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public._resolve_credit_note_line(jsonb, uuid, uuid) TO service_role;