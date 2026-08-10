INSERT INTO public.document_kinds (code, label, domain, legal_class, default_media_class, default_intents, allowed_formats, requires_party, is_active)
VALUES ('purchases.rfq', 'Request for Quotation', 'purchases', 'contractual', 'a4_portrait',
        ARRAY['view','download','email','print'], ARRAY['pdf'], true, true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.document_template_ast (kind_code, scope, version, label, is_default, is_active, media_class, ast)
SELECT 'purchases.rfq', 'system', 1, 'System default — Request for Quotation', true, true, 'a4_portrait',
  jsonb_build_object(
    'kind', 'purchases.rfq',
    'version', 1,
    'media_class', 'a4_portrait',
    'blocks', jsonb_build_array(
      jsonb_build_object('type','header','variant','branded'),
      jsonb_build_object('type','party','role','vendor'),
      jsonb_build_object('type','meta','fields', jsonb_build_array('number','date','due_date','currency')),
      jsonb_build_object('type','table','preset','line_items'),
      jsonb_build_object('type','notes','source','terms'),
      jsonb_build_object('type','footer','variant','branded')
    )
  )
WHERE NOT EXISTS (
  SELECT 1 FROM public.document_template_ast
   WHERE kind_code = 'purchases.rfq' AND scope = 'system' AND is_default
);

-- Freeze an RFQ into the shared document model so print, preview and the
-- invitation email all attach the SAME artifact. Prices are deliberately
-- absent: `rfq_items.target_price` is the buyer's internal ceiling and must
-- never reach a supplier.
CREATE OR REPLACE FUNCTION public.rfq_ensure_document_record(_rfq_id uuid, _supplier_id uuid DEFAULT NULL)
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
BEGIN
  SELECT * INTO v FROM public.rfqs WHERE id = _rfq_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RFQ not found'; END IF;

  SELECT b.id, b.name, b.legal_name, b.email, b.phone, b.address, b.logo_url, b.base_currency
    INTO v_biz FROM public.businesses b WHERE b.id = v.business_id;

  SELECT c.id, c.name, c.email, c.phone, c.address_line1, c.city, c.state, c.postal_code
    INTO v_party FROM public.contacts c WHERE c.id = _supplier_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'description', ri.description,
           'quantity', ri.quantity,
           'unit_price', 0,
           'tax_rate', 0,
           'tax_amount', 0,
           'line_total', 0,
           'sku', p.sku,
           'unit_of_measure', u.code
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
    'status', v.status,
    'issue_date', COALESCE(v.released_at, v.created_at)::date,
    'due_date', v.deadline::date,
    'subtotal', 0, 'tax_amount', 0, 'discount_amount', 0, 'total', 0,
    'currency', COALESCE(v.currency, v_biz.base_currency, 'USD'),
    'notes', v.notes,
    'terms', NULL,
    'contact', CASE WHEN v_party.id IS NULL THEN NULL ELSE jsonb_build_object(
        'name', v_party.name, 'email', v_party.email, 'phone', v_party.phone,
        'address_line1', v_party.address_line1, 'city', v_party.city,
        'state', v_party.state, 'postal_code', v_party.postal_code) END,
    'organization_id', v.organization_id,
    'business_id', v.business_id,
    'branch_id', v.branch_id,
    'items', v_items
  );

  v_record_id := public.ensure_document_record(
    p_kind_code       => 'purchases.rfq',
    p_organization_id => v.organization_id,
    p_source_module   => 'purchases',
    p_source_doc_type => 'rfq',
    p_source_doc_id   => v.id,
    p_business_id     => v.business_id,
    p_branch_id       => v.branch_id,
    p_party_kind      => CASE WHEN _supplier_id IS NULL THEN NULL ELSE 'supplier' END,
    p_party_id        => _supplier_id,
    p_currency        => COALESCE(v.currency, v_biz.base_currency, 'USD'),
    p_document_number => v.rfq_number,
    p_document_date   => COALESCE(v.released_at, v.created_at)::date,
    p_snapshot        => v_snapshot
  );

  RETURN v_record_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rfq_ensure_document_record(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.rfq_ensure_document_record(uuid, uuid) TO authenticated, service_role;