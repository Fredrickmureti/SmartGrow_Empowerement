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
  _client_request_id text DEFAULT NULL,
  _origin text DEFAULT 'adjustment',
  _reason_code text DEFAULT NULL,
  _source_return_id uuid DEFAULT NULL,
  _goods_receipt_id uuid DEFAULT NULL,
  _purchase_order_id uuid DEFAULT NULL,
  _vendor_document_number text DEFAULT NULL,
  _vendor_document_date date DEFAULT NULL,
  _exchange_rate numeric DEFAULT NULL,
  _exchange_rate_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_number text; v_id uuid;
  v_subtotal numeric := 0; v_tax numeric := 0;
  v_currency text;
  v_resolved jsonb;
  v_existing public.vendor_credit_notes%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '42501'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), _business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', _business_id USING ERRCODE = '42501';
  END IF;
  IF _items IS NULL OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'a vendor credit note needs at least one line';
  END IF;

  IF _client_request_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.vendor_credit_notes
     WHERE business_id = _business_id AND client_request_id = _client_request_id;
    IF FOUND THEN
      RETURN jsonb_build_object('id', v_existing.id,
                                'credit_note_number', v_existing.credit_note_number,
                                'total', v_existing.total, 'replayed', true);
    END IF;
  END IF;

  -- Server is the authority on line money and on the credit ceiling.
  v_resolved := public._resolve_vendor_credit_note_lines(_items, _bill_id, NULL);

  SELECT COALESCE(SUM((i->>'line_total')::numeric), 0),
         COALESCE(SUM(COALESCE((i->>'tax_amount')::numeric, 0)), 0)
    INTO v_subtotal, v_tax
    FROM jsonb_array_elements(v_resolved) i;

  SELECT COALESCE(NULLIF(b.currency, ''), (SELECT NULLIF(base_currency,'') FROM public.businesses WHERE id = _business_id), 'KES')
    INTO v_currency FROM public.bills b WHERE b.id = _bill_id;
  IF v_currency IS NULL THEN
    SELECT COALESCE(NULLIF(base_currency, ''), 'KES') INTO v_currency FROM public.businesses WHERE id = _business_id;
  END IF;

  v_number := public.get_next_vendor_credit_note_number(_org_id, _business_id);

  INSERT INTO public.vendor_credit_notes (
    organization_id, business_id, branch_id, credit_note_number, vendor_id, bill_id,
    status, credit_date, subtotal, tax_amount, total, amount_applied, currency, notes,
    created_by, client_request_id, origin, reason_code, source_return_id,
    goods_receipt_id, purchase_order_id, vendor_document_number, vendor_document_date,
    exchange_rate, exchange_rate_date
  ) VALUES (
    _org_id, _business_id, _branch_id, v_number, _vendor_id, _bill_id,
    'draft', COALESCE(_credit_date, CURRENT_DATE), v_subtotal, v_tax, v_subtotal + v_tax, 0,
    v_currency, _notes, auth.uid(), _client_request_id,
    COALESCE(NULLIF(_origin,''), 'adjustment'), _reason_code, _source_return_id,
    _goods_receipt_id, _purchase_order_id, _vendor_document_number, _vendor_document_date,
    _exchange_rate, COALESCE(_exchange_rate_date, _credit_date)
  ) RETURNING id INTO v_id;

  INSERT INTO public.vendor_credit_note_items (
    credit_note_id, product_id, account_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, sort_order, bill_item_id,
    source_unit_price, source_tax_rate)
  SELECT v_id,
         NULLIF(i->>'product_id','')::uuid,
         NULLIF(i->>'account_id','')::uuid,
         i->>'description',
         COALESCE((i->>'quantity')::numeric, 1),
         COALESCE((i->>'unit_price')::numeric, 0),
         COALESCE((i->>'tax_rate')::numeric, 0),
         COALESCE((i->>'tax_amount')::numeric, 0),
         COALESCE((i->>'line_total')::numeric, 0),
         COALESCE((i->>'sort_order')::int, ord::int - 1),
         NULLIF(i->>'bill_item_id','')::uuid,
         NULLIF(i->>'source_unit_price','')::numeric,
         NULLIF(i->>'source_tax_rate','')::numeric
    FROM jsonb_array_elements(v_resolved) WITH ORDINALITY AS t(i, ord);

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
  _items jsonb DEFAULT NULL,
  _origin text DEFAULT NULL,
  _reason_code text DEFAULT NULL,
  _vendor_document_number text DEFAULT NULL,
  _vendor_document_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v public.vendor_credit_notes%ROWTYPE;
  v_subtotal numeric := 0; v_tax numeric := 0; v_resolved jsonb;
  v_bill uuid;
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

  v_bill := COALESCE(_bill_id, v.bill_id);
  -- The note being edited is excluded from its own ceiling calculation.
  v_resolved := public._resolve_vendor_credit_note_lines(_items, v_bill, _vcn_id);

  SELECT COALESCE(SUM((i->>'line_total')::numeric), 0),
         COALESCE(SUM(COALESCE((i->>'tax_amount')::numeric, 0)), 0)
    INTO v_subtotal, v_tax
    FROM jsonb_array_elements(v_resolved) i;

  DELETE FROM public.vendor_credit_note_items WHERE credit_note_id = _vcn_id;

  INSERT INTO public.vendor_credit_note_items (
    credit_note_id, product_id, account_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, sort_order, bill_item_id,
    source_unit_price, source_tax_rate)
  SELECT _vcn_id,
         NULLIF(i->>'product_id','')::uuid,
         NULLIF(i->>'account_id','')::uuid,
         i->>'description',
         COALESCE((i->>'quantity')::numeric, 1),
         COALESCE((i->>'unit_price')::numeric, 0),
         COALESCE((i->>'tax_rate')::numeric, 0),
         COALESCE((i->>'tax_amount')::numeric, 0),
         COALESCE((i->>'line_total')::numeric, 0),
         COALESCE((i->>'sort_order')::int, ord::int - 1),
         NULLIF(i->>'bill_item_id','')::uuid,
         NULLIF(i->>'source_unit_price','')::numeric,
         NULLIF(i->>'source_tax_rate','')::numeric
    FROM jsonb_array_elements(v_resolved) WITH ORDINALITY AS t(i, ord);

  UPDATE public.vendor_credit_notes
     SET vendor_id   = COALESCE(_vendor_id, vendor_id),
         bill_id     = v_bill,
         credit_date = COALESCE(_credit_date, credit_date),
         notes       = COALESCE(_notes, notes),
         origin      = COALESCE(NULLIF(_origin,''), origin),
         reason_code = COALESCE(_reason_code, reason_code),
         vendor_document_number = COALESCE(_vendor_document_number, vendor_document_number),
         vendor_document_date   = COALESCE(_vendor_document_date, vendor_document_date),
         subtotal    = v_subtotal,
         tax_amount  = v_tax,
         total       = v_subtotal + v_tax,
         row_version = row_version + 1,
         updated_at  = now()
   WHERE id = _vcn_id
  RETURNING * INTO v;

  RETURN jsonb_build_object('id', v.id, 'credit_note_number', v.credit_note_number,
                            'total', v.total, 'row_version', v.row_version);
END
$fn$;

-- Purchase return raises a credit note that knows where it came from.
CREATE OR REPLACE FUNCTION public.purchase_return_raise_credit(_id uuid, _row_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_pr public.purchase_returns; v_items jsonb; v_res jsonb; v_cn_id uuid; v_prev text;
BEGIN
  v_pr := public._pret_load(_id, _row_version);
  IF v_pr.vendor_credit_note_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'already', true,
                              'vendor_credit_note_id', v_pr.vendor_credit_note_id);
  END IF;
  IF v_pr.status NOT IN ('dispatched','acknowledged')
     AND NOT (v_pr.return_kind = 'financial' AND v_pr.status = 'approved') THEN
    RAISE EXCEPTION 'A debit note can only be raised once the goods are dispatched (or for an approved financial adjustment)'
      USING ERRCODE='22023';
  END IF;
  v_prev := v_pr.status;

  SELECT jsonb_agg(jsonb_build_object(
           'description', ri.description, 'quantity', ri.quantity,
           'unit_price', ri.unit_price, 'tax_rate', COALESCE(ri.tax_rate,0),
           'tax_amount', COALESCE(ri.tax_amount,0), 'line_total', ri.line_total,
           'product_id', ri.product_id, 'sort_order', ri.sort_order)
           ORDER BY ri.sort_order)
    INTO v_items
    FROM public.purchase_return_items ri WHERE ri.purchase_return_id = _id;

  v_res := public.create_vendor_credit_note_atomic(
    _org_id := v_pr.organization_id,
    _business_id := v_pr.business_id,
    _branch_id := v_pr.branch_id,
    _vendor_id := v_pr.vendor_id,
    _bill_id := v_pr.bill_id,
    _credit_date := CURRENT_DATE,
    _notes := 'Vendor debit note for purchase return ' || v_pr.return_number ||
              COALESCE(' — ' || v_pr.reason_code, ''),
    _items := v_items,
    _issue := true,
    _client_request_id := 'purchase_return:' || _id::text,
    _origin := 'purchase_return',
    _reason_code := v_pr.reason_code,
    _source_return_id := v_pr.id,
    _goods_receipt_id := v_pr.goods_receipt_id,
    _purchase_order_id := v_pr.purchase_order_id,
    _exchange_rate := v_pr.exchange_rate,
    _exchange_rate_date := CURRENT_DATE);

  v_cn_id := NULLIF(v_res->>'credit_note_id','')::uuid;
  IF v_cn_id IS NULL THEN v_cn_id := NULLIF(v_res->>'id','')::uuid; END IF;

  PERFORM public._pret_lifecycle_begin();
  UPDATE public.purchase_returns
     SET vendor_credit_note_id = v_cn_id, credited_at = now(), status = 'credited',
         row_version = row_version + 1, updated_at = now()
   WHERE id = _id;
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id=_id;
  PERFORM public._pret_log(v_pr, 'credited', v_prev, 'credited', v_res);

  PERFORM public._pret_emit_outbox(v_pr, 'credited',
    jsonb_build_object('return_number', v_pr.return_number,
                       'vendor_id', v_pr.vendor_id,
                       'bill_id', v_pr.bill_id,
                       'vendor_credit_note_id', v_cn_id,
                       'amount', v_pr.total,
                       'currency', v_pr.currency,
                       'credited_at', v_pr.credited_at));

  RETURN jsonb_build_object('success', true, 'row_version', v_pr.row_version,
                            'vendor_credit_note_id', v_cn_id, 'credit_note', v_res);
END
$fn$;

GRANT EXECUTE ON FUNCTION public.create_vendor_credit_note_atomic(uuid, uuid, uuid, uuid, uuid, date, text, jsonb, boolean, text, text, text, uuid, uuid, uuid, text, date, numeric, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_vendor_credit_note_atomic(uuid, uuid, uuid, date, text, jsonb, text, text, text, date) TO authenticated;

NOTIFY pgrst, 'reload schema';