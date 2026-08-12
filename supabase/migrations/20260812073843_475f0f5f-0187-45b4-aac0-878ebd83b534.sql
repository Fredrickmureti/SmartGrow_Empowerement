ALTER TABLE public.vendor_credit_notes
  ADD COLUMN IF NOT EXISTS client_request_id text;

CREATE UNIQUE INDEX IF NOT EXISTS vendor_credit_notes_biz_client_request_id_uq
  ON public.vendor_credit_notes (business_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.create_vendor_credit_note_atomic(uuid, uuid, uuid, uuid, uuid, date, text, jsonb, boolean);

CREATE OR REPLACE FUNCTION public.create_vendor_credit_note_atomic(
  _org_id uuid,
  _business_id uuid,
  _branch_id uuid,
  _vendor_id uuid,
  _bill_id uuid,
  _credit_date date,
  _notes text,
  _items jsonb,
  _issue boolean DEFAULT false,
  _client_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_number text; v_id uuid;
  v_subtotal numeric := 0; v_tax numeric := 0;
  v_currency text;
  v_existing public.vendor_credit_notes%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '42501'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), _business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', _business_id USING ERRCODE = '42501';
  END IF;
  IF _items IS NULL OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'a vendor credit note needs at least one line';
  END IF;

  -- Idempotent replay: the same intent key never creates a second document.
  IF _client_request_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.vendor_credit_notes
     WHERE business_id = _business_id AND client_request_id = _client_request_id;
    IF FOUND THEN
      RETURN jsonb_build_object('id', v_existing.id,
                                'credit_note_number', v_existing.credit_note_number,
                                'total', v_existing.total,
                                'replayed', true);
    END IF;
  END IF;

  SELECT COALESCE(SUM((i->>'line_total')::numeric), 0),
         COALESCE(SUM(COALESCE((i->>'tax_amount')::numeric, 0)), 0)
    INTO v_subtotal, v_tax
    FROM jsonb_array_elements(_items) i;

  SELECT COALESCE(NULLIF(b.currency, ''), (SELECT NULLIF(base_currency,'') FROM public.businesses WHERE id = _business_id), 'KES')
    INTO v_currency FROM public.bills b WHERE b.id = _bill_id;
  IF v_currency IS NULL THEN
    SELECT COALESCE(NULLIF(base_currency, ''), 'KES') INTO v_currency FROM public.businesses WHERE id = _business_id;
  END IF;

  v_number := public.get_next_vendor_credit_note_number(_org_id, _business_id);

  INSERT INTO public.vendor_credit_notes (
    organization_id, business_id, branch_id, credit_note_number, vendor_id, bill_id,
    status, credit_date, subtotal, tax_amount, total, amount_applied, currency, notes,
    created_by, client_request_id
  ) VALUES (
    _org_id, _business_id, _branch_id, v_number, _vendor_id, _bill_id,
    'draft', COALESCE(_credit_date, CURRENT_DATE), v_subtotal, v_tax, v_subtotal + v_tax, 0,
    v_currency, _notes, auth.uid(), _client_request_id
  ) RETURNING id INTO v_id;

  INSERT INTO public.vendor_credit_note_items (
    credit_note_id, product_id, account_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, sort_order)
  SELECT v_id,
         NULLIF(i->>'product_id','')::uuid,
         NULLIF(i->>'account_id','')::uuid,
         i->>'description',
         COALESCE((i->>'quantity')::numeric, 1),
         COALESCE((i->>'unit_price')::numeric, 0),
         COALESCE((i->>'tax_rate')::numeric, 0),
         COALESCE((i->>'tax_amount')::numeric, 0),
         COALESCE((i->>'line_total')::numeric, 0),
         COALESCE((i->>'sort_order')::int, ord::int)
    FROM jsonb_array_elements(_items) WITH ORDINALITY AS t(i, ord);

  IF _issue THEN
    PERFORM public.issue_vendor_credit_note_atomic(v_id);
  END IF;

  RETURN jsonb_build_object('id', v_id, 'credit_note_number', v_number, 'total', v_subtotal + v_tax);
END
$fn$;

CREATE OR REPLACE FUNCTION public.update_vendor_credit_note_atomic(
  _vcn_id uuid,
  _vendor_id uuid DEFAULT NULL,
  _bill_id uuid DEFAULT NULL,
  _credit_date date DEFAULT NULL,
  _notes text DEFAULT NULL,
  _items jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v public.vendor_credit_notes%ROWTYPE;
  v_subtotal numeric := 0; v_tax numeric := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v FROM public.vendor_credit_notes WHERE id = _vcn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vendor credit note % not found', _vcn_id USING ERRCODE='P0002'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v.business_id USING ERRCODE = '42501';
  END IF;
  IF v.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft vendor credit notes can be edited (current: %)', v.status USING ERRCODE='22023';
  END IF;
  IF _items IS NULL OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'a vendor credit note needs at least one line';
  END IF;

  SELECT COALESCE(SUM((i->>'line_total')::numeric), 0),
         COALESCE(SUM(COALESCE((i->>'tax_amount')::numeric, 0)), 0)
    INTO v_subtotal, v_tax
    FROM jsonb_array_elements(_items) i;

  DELETE FROM public.vendor_credit_note_items WHERE credit_note_id = _vcn_id;

  INSERT INTO public.vendor_credit_note_items (
    credit_note_id, product_id, account_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, sort_order)
  SELECT _vcn_id,
         NULLIF(i->>'product_id','')::uuid,
         NULLIF(i->>'account_id','')::uuid,
         i->>'description',
         COALESCE((i->>'quantity')::numeric, 1),
         COALESCE((i->>'unit_price')::numeric, 0),
         COALESCE((i->>'tax_rate')::numeric, 0),
         COALESCE((i->>'tax_amount')::numeric, 0),
         COALESCE((i->>'line_total')::numeric, 0),
         COALESCE((i->>'sort_order')::int, ord::int)
    FROM jsonb_array_elements(_items) WITH ORDINALITY AS t(i, ord);

  UPDATE public.vendor_credit_notes
     SET vendor_id   = COALESCE(_vendor_id, vendor_id),
         bill_id     = CASE WHEN _bill_id IS NULL THEN bill_id ELSE _bill_id END,
         credit_date = COALESCE(_credit_date, credit_date),
         notes       = COALESCE(_notes, notes),
         subtotal    = v_subtotal,
         tax_amount  = v_tax,
         total       = v_subtotal + v_tax,
         updated_at  = now()
   WHERE id = _vcn_id
  RETURNING * INTO v;

  RETURN jsonb_build_object('id', v.id, 'credit_note_number', v.credit_note_number, 'total', v.total);
END
$fn$;

CREATE OR REPLACE FUNCTION public.delete_vendor_credit_note_atomic(_vcn_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v public.vendor_credit_notes%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v FROM public.vendor_credit_notes WHERE id = _vcn_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', true, 'already', true); END IF;
  IF NOT public.user_can_access_business(auth.uid(), v.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v.business_id USING ERRCODE = '42501';
  END IF;
  IF v.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft vendor credit notes can be deleted (current: %)', v.status USING ERRCODE='22023';
  END IF;
  IF v.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'A posted vendor credit note cannot be deleted; reverse it instead' USING ERRCODE='22023';
  END IF;

  DELETE FROM public.vendor_credit_note_items WHERE credit_note_id = _vcn_id;
  DELETE FROM public.vendor_credit_notes WHERE id = _vcn_id;

  RETURN jsonb_build_object('success', true, 'id', _vcn_id);
END
$fn$;

GRANT EXECUTE ON FUNCTION public.create_vendor_credit_note_atomic(uuid, uuid, uuid, uuid, uuid, date, text, jsonb, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_vendor_credit_note_atomic(uuid, uuid, uuid, date, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_vendor_credit_note_atomic(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';