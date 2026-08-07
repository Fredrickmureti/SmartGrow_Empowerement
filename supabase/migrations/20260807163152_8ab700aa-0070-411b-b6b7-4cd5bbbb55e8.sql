CREATE OR REPLACE FUNCTION public.create_credit_note_atomic(
  _org_id uuid DEFAULT NULL,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
  _contact_id uuid DEFAULT NULL,
  _invoice_id uuid DEFAULT NULL,
  _issue_date date DEFAULT NULL,
  _reason text DEFAULT NULL,
  _notes text DEFAULT NULL,
  _items jsonb DEFAULT NULL,
  _source_return_id uuid DEFAULT NULL,
  _issue boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
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
  IF _business_id IS NULL OR NOT public.user_can_access_business(auth.uid(), _business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', _business_id USING ERRCODE = '42501';
  END IF;
  IF _contact_id IS NULL THEN
    RAISE EXCEPTION 'A credit note requires a customer';
  END IF;
  IF _items IS NULL OR jsonb_typeof(_items) <> 'array' OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'A credit note requires at least one line';
  END IF;

  SELECT COALESCE(_org_id, organization_id), COALESCE(NULLIF(base_currency, ''), 'KES')
    INTO v_org, v_currency
  FROM public.businesses WHERE id = _business_id;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Unable to resolve organization for business %', _business_id;
  END IF;

  SELECT COALESCE(SUM((i->>'line_total')::numeric), 0),
         COALESCE(SUM((i->>'tax_amount')::numeric), 0)
    INTO v_subtotal, v_tax
  FROM jsonb_array_elements(_items) i;

  IF v_subtotal + v_tax <= 0 THEN
    RAISE EXCEPTION 'Credit note total must be positive';
  END IF;

  v_branch := COALESCE((SELECT branch_id FROM public.invoices WHERE id = _invoice_id), _branch_id);
  v_number := public.get_next_credit_note_number(v_org, _business_id, v_branch);

  INSERT INTO public.credit_notes (
    organization_id, business_id, branch_id, contact_id, invoice_id, original_invoice_id,
    credit_note_number, status, issue_date, subtotal, tax_amount, total,
    currency, reason, notes, source_return_id, created_by
  ) VALUES (
    v_org, _business_id, v_branch, _contact_id, _invoice_id, _invoice_id,
    v_number, 'draft'::credit_note_status, COALESCE(_issue_date, CURRENT_DATE),
    v_subtotal, v_tax, v_subtotal + v_tax,
    COALESCE(v_currency, 'KES'), _reason, _notes, _source_return_id, auth.uid()
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
  FROM jsonb_array_elements(_items) WITH ORDINALITY AS t(i, ord);

  IF _issue THEN
    PERFORM public.issue_credit_note_atomic(v_cn_id);
  END IF;

  RETURN jsonb_build_object('credit_note_id', v_cn_id, 'credit_note_number', v_number);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.create_credit_note_atomic(uuid, uuid, uuid, uuid, uuid, date, text, text, jsonb, uuid, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';