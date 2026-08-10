-- ============================================================
-- Procurement documents: RFQ (solicitation) + Requisition (internal demand)
--
-- The RFQ template was seeded as the sales-invoice skeleton with the money
-- fields zero-filled. That made the renderer draw an invoice with an empty
-- totals ladder. An RFQ asks the supplier to state the price; a requisition
-- has no counterparty at all. Both get their own AST and their own layout.
-- ============================================================

-- ---------- 1. Purchase requisition kind (internal-only) ----------
INSERT INTO public.document_kinds (
  code, label, domain, legal_class, default_media_class,
  default_intents, allowed_formats, requires_party, is_active
)
VALUES (
  'purchases.requisition', 'Purchase Requisition', 'purchases', 'internal', 'a4_portrait',
  -- NO 'email' intent: a requisition is an approval artefact, never
  -- supplier-facing. Omitting the intent is the enforcement point.
  ARRAY['view','download','print'], ARRAY['pdf'], false, true
)
ON CONFLICT (code) DO UPDATE
  SET label             = EXCLUDED.label,
      default_intents   = EXCLUDED.default_intents,
      requires_party    = EXCLUDED.requires_party,
      is_active         = true;

INSERT INTO public.document_template_ast (
  kind_code, scope, version, label, is_default, is_active, media_class, ast
)
SELECT 'purchases.requisition', 'system', 1,
       'System default — Purchase Requisition', true, true, 'a4_portrait',
  jsonb_build_object(
    'kind', 'purchases.requisition',
    'version', 1,
    'media_class', 'a4_portrait',
    'layout', 'requisition',
    'blocks', jsonb_build_array(
      jsonb_build_object('type','header','variant','branded'),
      jsonb_build_object('type','meta','fields',
        jsonb_build_array('number','revision','status','date','need_by',
                          'requester','cost_center','project','destination')),
      jsonb_build_object('type','notes','source','justification'),
      jsonb_build_object('type','table','preset','demand_lines'),
      jsonb_build_object('type','table','preset','approval_trail'),
      jsonb_build_object('type','notes','source','notes'),
      jsonb_build_object('type','footer','variant','internal')
    )
  )
WHERE NOT EXISTS (
  SELECT 1 FROM public.document_template_ast
   WHERE kind_code = 'purchases.requisition' AND scope = 'system' AND is_default
);

-- ---------- 2. RFQ: retire the invoice-shaped AST ----------
UPDATE public.document_template_ast
   SET is_default = false, is_active = false
 WHERE kind_code = 'purchases.rfq'
   AND scope = 'system'
   AND version = 1;

INSERT INTO public.document_template_ast (
  kind_code, scope, version, label, is_default, is_active, media_class, ast
)
SELECT 'purchases.rfq', 'system', 2,
       'System default — Request for Quotation (sourcing layout)', true, true, 'a4_portrait',
  jsonb_build_object(
    'kind', 'purchases.rfq',
    'version', 2,
    'media_class', 'a4_portrait',
    'layout', 'solicitation',
    'blocks', jsonb_build_array(
      jsonb_build_object('type','header','variant','branded'),
      jsonb_build_object('type','meta','fields',
        jsonb_build_array('number','revision','date','response_deadline',
                          'required_by','currency','buyer_contact')),
      jsonb_build_object('type','party','role','invited_supplier'),
      jsonb_build_object('type','notes','source','delivery_location'),
      -- Requirements, NOT line items: no unit price, tax or line total.
      jsonb_build_object('type','table','preset','requirements'),
      jsonb_build_object('type','notes','source','response_instructions'),
      jsonb_build_object('type','notes','source','commercial_requirements'),
      jsonb_build_object('type','notes','source','terms'),
      jsonb_build_object('type','footer','variant','branded')
    )
  )
WHERE NOT EXISTS (
  SELECT 1 FROM public.document_template_ast
   WHERE kind_code = 'purchases.rfq' AND scope = 'system' AND version = 2
);

-- ---------- 3. SQL twin of buildPurchasesRfqSnapshot ----------
-- Keep in step with src/services/documents/snapshots/purchasesRfq.ts.
-- Money fields are ABSENT, not zero: a zero price on a solicitation reads
-- to a supplier as "we expect this for free".
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
  v_currency text;
  v_revision int;
  v_docnum text;
  v_location text;
BEGIN
  SELECT * INTO v FROM public.rfqs WHERE id = _rfq_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RFQ not found'; END IF;

  SELECT b.id, b.name, b.legal_name, b.email, b.phone, b.address, b.logo_url, b.base_currency
    INTO v_biz FROM public.businesses b WHERE b.id = v.business_id;

  SELECT c.id, c.name, c.email, c.phone, c.address_line1, c.city, c.state, c.postal_code, c.country
    INTO v_party FROM public.contacts c WHERE c.id = _supplier_id;

  v_currency := COALESCE(v.currency, v_biz.base_currency, 'USD');
  v_revision := COALESCE(v.version, 1);
  -- Each revision is a distinct solicitation with its own frozen record,
  -- so a supplier can never be left quoting a superseded requirement.
  v_docnum := CASE WHEN v_revision > 1
                   THEN v.rfq_number || '-R' || v_revision
                   ELSE v.rfq_number END;

  SELECT COALESCE(w.name || COALESCE(E'\n' || w.address, ''),
                  br.name || COALESCE(E'\n' || br.address, ''))
    INTO v_location
    FROM (SELECT 1) _
    LEFT JOIN public.warehouses w ON w.id = v.deliver_to_warehouse_id
    LEFT JOIN public.branches   br ON br.id = v.deliver_to_branch_id;

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
        'state', v_party.state, 'postal_code', v_party.postal_code,
        'country', v_party.country) END,
    'buyer_contact_name', NULL,
    'buyer_contact_email', v_biz.email,
    'delivery_location', v_location,
    'response_instructions',
      'Submit your quotation quoting RFQ ' || v.rfq_number
      || CASE WHEN v_revision > 1 THEN ' revision ' || v_revision ELSE '' END
      || CASE WHEN v.deadline IS NULL THEN ''
              ELSE ' on or before ' || v.deadline::date END
      || '. Quote in ' || v_currency || ', stating unit price, lead time, '
      || 'validity period and payment terms for every line.',
    'commercial_requirements', NULL,
    'notes', v.notes,
    'terms', NULL,
    'business_name', v_biz.name,
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
    p_currency        => v_currency,
    p_document_number => v_docnum,
    p_document_date   => COALESCE(v.released_at, v.created_at)::date,
    p_snapshot        => v_snapshot
  );

  RETURN v_record_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rfq_ensure_document_record(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.rfq_ensure_document_record(uuid, uuid) TO authenticated, service_role;
