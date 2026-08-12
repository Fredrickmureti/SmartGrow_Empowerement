CREATE OR REPLACE FUNCTION public.create_supplier(
  p_business_id uuid,
  p_contact_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_tax_id text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_supplier_code text DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_default_currency text DEFAULT NULL,
  p_default_incoterms text DEFAULT NULL,
  p_default_lead_time_days integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id uuid;
  v_contact RECORD;
  v_contact_id uuid;
  v_supplier_id uuid;
  v_created boolean := false;
BEGIN
  SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = p_business_id;
  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Business not found');
  END IF;

  IF NOT public.user_has_business_access(auth.uid(), p_business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;

  -- ── Party (contacts) is the canonical identity — ADR-0038 / ADR-0079 ──
  IF p_contact_id IS NOT NULL THEN
    SELECT * INTO v_contact FROM public.contacts WHERE id = p_contact_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'Contact not found');
    END IF;
    IF v_contact.business_id IS DISTINCT FROM p_business_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'Contact belongs to another company');
    END IF;

    -- Promote the existing party to the supplier role; never duplicate it.
    UPDATE public.contacts
       SET supplier_rank = GREATEST(COALESCE(supplier_rank, 0), 1),
           type = CASE WHEN COALESCE(customer_rank, 0) > 0 OR type IN ('customer', 'both')
                       THEN 'both'::contact_type ELSE 'supplier'::contact_type END,
           tax_id = COALESCE(NULLIF(btrim(p_tax_id), ''), tax_id),
           email  = COALESCE(NULLIF(btrim(p_email), ''), email),
           phone  = COALESCE(NULLIF(btrim(p_phone), ''), phone),
           updated_at = now()
     WHERE id = p_contact_id;
    v_contact_id := p_contact_id;
  ELSE
    IF COALESCE(btrim(p_name), '') = '' THEN
      RETURN jsonb_build_object('success', false, 'error', 'Supplier name is required');
    END IF;
    INSERT INTO public.contacts (
      organization_id, business_id, type, name, email, phone, tax_id, notes, supplier_rank
    ) VALUES (
      v_org_id, p_business_id, 'supplier'::contact_type, btrim(p_name),
      NULLIF(btrim(p_email), ''), NULLIF(btrim(p_phone), ''),
      NULLIF(btrim(p_tax_id), ''), NULLIF(btrim(p_notes), ''), 1
    )
    RETURNING id INTO v_contact_id;
  END IF;

  -- ── Procurement role record ──
  SELECT id INTO v_supplier_id
    FROM public.suppliers
   WHERE business_id = p_business_id AND contact_id = v_contact_id;

  IF v_supplier_id IS NULL THEN
    INSERT INTO public.suppliers (
      organization_id, business_id, contact_id, category_id, supplier_code,
      lifecycle_state, default_currency, default_incoterms, default_lead_time_days, created_by
    ) VALUES (
      v_org_id, p_business_id, v_contact_id, p_category_id,
      NULLIF(btrim(p_supplier_code), ''), 'draft',
      NULLIF(btrim(p_default_currency), ''), NULLIF(btrim(p_default_incoterms), ''),
      p_default_lead_time_days, auth.uid()
    )
    RETURNING id INTO v_supplier_id;
    v_created := true;
  END IF;

  IF v_created THEN
    INSERT INTO public.business_event_outbox (
      org_id, event_type, source_doc_type, source_doc_id, payload,
      idempotency_key, actor_user_id, source
    ) VALUES (
      v_org_id, 'supplier.created', 'supplier', v_supplier_id,
      jsonb_build_object('business_id', p_business_id, 'contact_id', v_contact_id,
                         'lifecycle_state', 'draft'),
      'supplier.created:' || v_supplier_id::text || ':draft', auth.uid(), 'procurement'
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'supplier_id', v_supplier_id,
    'contact_id', v_contact_id,
    'created', v_created
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'A supplier with this code already exists for this company');
END $function$;

REVOKE ALL ON FUNCTION public.create_supplier(uuid, uuid, text, text, text, text, text, text, uuid, text, text, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.create_supplier(uuid, uuid, text, text, text, text, text, text, uuid, text, text, integer) TO authenticated;