CREATE OR REPLACE FUNCTION public.rfq_snapshot_assert_solicitation(_snapshot jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_forbidden text;
BEGIN
  IF COALESCE(_snapshot->>'document_type', '') <> 'rfq' THEN
    RAISE EXCEPTION 'RFQ snapshot must declare document_type=rfq' USING ERRCODE = '22023';
  END IF;

  SELECT key INTO v_forbidden
  FROM jsonb_object_keys(COALESCE(_snapshot, '{}'::jsonb)) AS key
  WHERE lower(key) IN (
    'target_price', 'price', 'unit_price', 'tax', 'tax_rate', 'tax_amount',
    'amount', 'line_amount', 'line_total', 'subtotal', 'total', 'amount_due',
    'balance_due', 'payment_instructions'
  )
  LIMIT 1;

  IF v_forbidden IS NULL THEN
    SELECT key INTO v_forbidden
    FROM jsonb_array_elements(COALESCE(_snapshot->'items', '[]'::jsonb)) AS item
    CROSS JOIN LATERAL jsonb_object_keys(item) AS key
    WHERE lower(key) IN (
      'target_price', 'price', 'unit_price', 'tax', 'tax_rate', 'tax_amount',
      'amount', 'line_amount', 'line_total', 'subtotal', 'total', 'amount_due',
      'balance_due', 'payment_instructions'
    )
    LIMIT 1;
  END IF;

  IF v_forbidden IS NOT NULL THEN
    RAISE EXCEPTION 'RFQ solicitation snapshot contains forbidden monetary field: %', v_forbidden
      USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.rfq_snapshot_assert_solicitation(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rfq_snapshot_assert_solicitation(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rfq_ensure_document_record(_rfq_id uuid, _supplier_id uuid DEFAULT NULL::uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v public.rfqs;
  v_biz RECORD;
  v_party RECORD;
  v_items jsonb;
  v_snapshot jsonb;
  v_record_id uuid;
  v_previous_id uuid;
  v_currency text;
  v_revision int;
  v_docnum text;
  v_location text;
  v_source_type text;
BEGIN
  SELECT * INTO v FROM public.rfqs WHERE id = _rfq_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RFQ not found'; END IF;

  PERFORM public._assert_org_member(v.organization_id);

  SELECT b.id, b.name, b.legal_name, b.email, b.phone, b.address, b.logo_url, b.base_currency
    INTO v_biz FROM public.businesses b WHERE b.id = v.business_id;

  SELECT c.id, c.name, c.email, c.phone, c.address_line1, c.city, c.state, c.postal_code, c.country
    INTO v_party FROM public.contacts c WHERE c.id = _supplier_id;

  v_currency := COALESCE(v.currency, v_biz.base_currency, 'USD');
  v_revision := COALESCE(v.version, 1);
  v_source_type := 'rfq:r' || v_revision::text || CASE WHEN _supplier_id IS NULL THEN ':buyer' ELSE ':supplier:' || _supplier_id::text END;
  v_docnum := CASE WHEN v_revision > 1 THEN v.rfq_number || '-R' || v_revision ELSE v.rfq_number END;

  SELECT COALESCE(w.name || COALESCE(E'\n' || w.address, ''), br.name || COALESCE(E'\n' || br.address, ''))
    INTO v_location
    FROM (SELECT 1) _
    LEFT JOIN public.warehouses w ON w.id = v.deliver_to_warehouse_id
    LEFT JOIN public.branches br ON br.id = v.deliver_to_branch_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'description', ri.description,
           'specification', ri.specification,
           'quantity', ri.quantity,
           'sku', p.sku,
           'unit_of_measure', u.code,
           'required_by_date', ri.need_by_date
         ) ORDER BY COALESCE(ri.sort_order, 0)), '[]'::jsonb)
    INTO v_items
    FROM public.rfq_items ri
    LEFT JOIN public.products p ON p.id = ri.product_id
    LEFT JOIN public.units_of_measure u ON u.id = ri.uom_id
   WHERE ri.rfq_id = v.id;

  v_snapshot := jsonb_build_object(
    'document_type', 'rfq',
    'document_type_label', 'REQUEST FOR QUOTATION',
    'document_number', v.rfq_number,
    'revision', v_revision,
    'status', v.status,
    'issue_date', COALESCE(v.released_at, v.created_at)::date,
    'response_deadline', v.deadline::date,
    'required_by_date', v.required_by_date::date,
    'currency', v_currency,
    'supplier', CASE WHEN v_party.id IS NULL THEN NULL ELSE jsonb_build_object(
      'name', v_party.name, 'email', v_party.email, 'phone', v_party.phone,
      'address_line1', v_party.address_line1, 'city', v_party.city,
      'state', v_party.state, 'postal_code', v_party.postal_code, 'country', v_party.country) END,
    'buyer_contact_name', NULL,
    'buyer_contact_email', v_biz.email,
    'delivery_location', v_location,
    'response_instructions',
      'Submit your quotation quoting RFQ ' || v.rfq_number
      || CASE WHEN v_revision > 1 THEN ' revision ' || v_revision ELSE '' END
      || CASE WHEN v.deadline IS NULL THEN '' ELSE ' on or before ' || v.deadline::date END
      || '. Quote in ' || v_currency || ', stating unit price, lead time, validity period and payment terms for every line.',
    'commercial_requirements', NULL,
    'notes', v.notes,
    'terms', NULL,
    'business_name', v_biz.name,
    'organization_id', v.organization_id,
    'business_id', v.business_id,
    'branch_id', v.branch_id,
    'items', v_items
  );

  PERFORM public.rfq_snapshot_assert_solicitation(v_snapshot);

  SELECT id INTO v_record_id
  FROM public.document_records
  WHERE organization_id = v.organization_id
    AND source_module = 'purchases'
    AND source_doc_type = v_source_type
    AND source_doc_id = v.id
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_record_id IS NOT NULL THEN
    RETURN v_record_id;
  END IF;

  SELECT id INTO v_previous_id
  FROM public.document_records
  WHERE organization_id = v.organization_id
    AND source_module = 'purchases'
    AND source_doc_id = v.id
    AND kind_code = 'purchases.rfq'
    AND superseded_by IS NULL
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  INSERT INTO public.document_records (
    organization_id, business_id, branch_id, kind_code, version,
    source_module, source_doc_type, source_doc_id,
    party_kind, party_id, currency, metadata, created_by,
    document_number, document_date, snapshot
  ) VALUES (
    v.organization_id, v.business_id, v.branch_id, 'purchases.rfq', v_revision,
    'purchases', v_source_type, v.id,
    CASE WHEN _supplier_id IS NULL THEN NULL ELSE 'supplier' END,
    _supplier_id, v_currency,
    jsonb_build_object('rfq_revision', v_revision, 'copy_scope', CASE WHEN _supplier_id IS NULL THEN 'buyer' ELSE 'supplier' END),
    auth.uid(), v_docnum, COALESCE(v.released_at, v.created_at)::date, v_snapshot
  ) RETURNING id INTO v_record_id;

  IF v_previous_id IS NOT NULL AND v_previous_id <> v_record_id THEN
    UPDATE public.document_records SET superseded_by = v_record_id, updated_at = now() WHERE id = v_previous_id;
  END IF;

  RETURN v_record_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rfq_ensure_document_record(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rfq_ensure_document_record(uuid, uuid) TO authenticated, service_role;