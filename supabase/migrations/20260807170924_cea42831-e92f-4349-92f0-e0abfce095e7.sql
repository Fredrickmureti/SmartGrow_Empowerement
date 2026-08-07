-- Convergence (ADR 0131): exactly ONE credit note creation entry point.
-- Drops the unreachable unnamed-arg overload and the duplicate request shim,
-- and re-homes the full writer body in the canonical named-envelope function.

DROP FUNCTION IF EXISTS public.create_credit_note_request_atomic(jsonb);
DROP FUNCTION IF EXISTS public.create_credit_note_atomic(jsonb);
DROP FUNCTION IF EXISTS public.create_credit_note_atomic(uuid, uuid, uuid, uuid, uuid, date, text, text, jsonb, uuid, boolean);

CREATE FUNCTION public.create_credit_note_atomic(_payload jsonb)
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
  v_cn_id uuid;
  v_number text;
  v_subtotal numeric := 0;
  v_tax numeric := 0;
  v_currency text;
  v_branch uuid;
  v_org uuid;
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

  IF v_business_id IS NULL OR NOT public.user_can_access_business(auth.uid(), v_business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_business_id USING ERRCODE = '42501';
  END IF;
  IF v_contact_id IS NULL THEN
    RAISE EXCEPTION 'A credit note requires a customer';
  END IF;
  IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'A credit note requires at least one line';
  END IF;

  SELECT COALESCE(v_org_id, organization_id), COALESCE(NULLIF(base_currency, ''), 'KES')
    INTO v_org, v_currency
  FROM public.businesses WHERE id = v_business_id;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Unable to resolve organization for business %', v_business_id;
  END IF;

  SELECT COALESCE(SUM((i->>'line_total')::numeric), 0),
         COALESCE(SUM((i->>'tax_amount')::numeric), 0)
    INTO v_subtotal, v_tax
  FROM jsonb_array_elements(v_items) i;

  IF v_subtotal + v_tax <= 0 THEN
    RAISE EXCEPTION 'Credit note total must be positive';
  END IF;

  v_branch := COALESCE((SELECT branch_id FROM public.invoices WHERE id = v_invoice_id), v_branch_id);
  v_number := public.get_next_credit_note_number(v_org, v_business_id, v_branch);

  INSERT INTO public.credit_notes (
    organization_id, business_id, branch_id, contact_id, invoice_id, original_invoice_id,
    credit_note_number, status, issue_date, subtotal, tax_amount, total,
    currency, reason, notes, source_return_id, created_by
  ) VALUES (
    v_org, v_business_id, v_branch, v_contact_id, v_invoice_id, v_invoice_id,
    v_number, 'draft'::credit_note_status, COALESCE(v_issue_date, CURRENT_DATE),
    v_subtotal, v_tax, v_subtotal + v_tax,
    COALESCE(v_currency, 'KES'), v_reason, v_notes, v_source_return_id, auth.uid()
  ) RETURNING id INTO v_cn_id;

  INSERT INTO public.credit_note_items (
    credit_note_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, sort_order,
    packaging_id, display_uom_id, display_quantity, lot_number, serial_number
  )
  SELECT v_cn_id,
         NULLIF(i->>'product_id','')::uuid,
         i->>'description',
         COALESCE((i->>'quantity')::numeric, 0),
         COALESCE((i->>'unit_price')::numeric, 0),
         COALESCE((i->>'tax_rate')::numeric, 0),
         COALESCE((i->>'tax_amount')::numeric, 0),
         COALESCE((i->>'line_total')::numeric, 0),
         COALESCE((i->>'sort_order')::integer, (ord - 1)::integer),
         NULLIF(i->>'packaging_id','')::uuid,
         NULLIF(i->>'display_uom_id','')::uuid,
         NULLIF(i->>'display_quantity','')::numeric,
         NULLIF(i->>'lot_number',''),
         NULLIF(i->>'serial_number','')
  FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(i, ord);

  IF v_issue THEN
    PERFORM public.issue_credit_note_atomic(v_cn_id);
  END IF;

  RETURN jsonb_build_object('credit_note_id', v_cn_id, 'credit_note_number', v_number);
END;
$function$;

REVOKE ALL ON FUNCTION public.create_credit_note_atomic(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_credit_note_atomic(jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';