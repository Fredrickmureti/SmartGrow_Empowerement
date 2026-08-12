-- ═══ create_supplier: converge with the auto-provision trigger ═══════════
CREATE OR REPLACE FUNCTION public.create_supplier(
  p_business_id uuid,
  p_name text DEFAULT NULL,
  p_contact_id uuid DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_tax_id text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_supplier_code text DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_default_currency text DEFAULT NULL,
  p_default_incoterms text DEFAULT NULL,
  p_default_lead_time_days integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_contact RECORD;
  v_contact_id uuid;
  v_supplier_id uuid;
  v_existing uuid;
  v_created boolean := false;
BEGIN
  SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = p_business_id;
  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Business not found');
  END IF;
  IF NOT public.user_has_business_access(auth.uid(), p_business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;

  IF p_contact_id IS NOT NULL THEN
    SELECT * INTO v_contact FROM public.contacts WHERE id = p_contact_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'Contact not found');
    END IF;
    IF v_contact.business_id IS DISTINCT FROM p_business_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'Contact belongs to another company');
    END IF;
    SELECT id INTO v_existing FROM public.suppliers
     WHERE business_id = p_business_id AND contact_id = p_contact_id;
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
    ) RETURNING id INTO v_contact_id;
  END IF;

  -- The contacts trigger has already provisioned the role row; this is idempotent.
  v_supplier_id := public.ensure_supplier_for_contact(v_contact_id);
  v_created := (v_existing IS NULL);

  UPDATE public.suppliers
     SET category_id             = COALESCE(p_category_id, category_id),
         supplier_code           = COALESCE(NULLIF(btrim(p_supplier_code), ''), supplier_code,
                                            public.next_supplier_code(p_business_id)),
         default_currency        = COALESCE(NULLIF(btrim(p_default_currency), ''), default_currency),
         default_incoterms       = COALESCE(NULLIF(btrim(p_default_incoterms), ''), default_incoterms),
         default_lead_time_days  = COALESCE(p_default_lead_time_days, default_lead_time_days),
         created_by              = COALESCE(created_by, auth.uid()),
         updated_at              = now()
   WHERE id = v_supplier_id;

  IF v_created THEN
    INSERT INTO public.business_event_outbox (
      org_id, event_type, source_doc_type, source_doc_id, payload,
      idempotency_key, actor_user_id, source
    ) VALUES (
      v_org_id, 'supplier.created', 'supplier', v_supplier_id,
      jsonb_build_object('business_id', p_business_id, 'contact_id', v_contact_id,
                         'lifecycle_state', 'draft'),
      'supplier.created:' || v_supplier_id::text || ':draft', auth.uid(), 'procurement'
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('success', true, 'supplier_id', v_supplier_id,
                            'contact_id', v_contact_id, 'created', v_created);
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'A supplier with this code already exists for this company');
END $$;

-- ═══ Commercial terms change history ═════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.supplier_terms_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  changed_by uuid,
  reason text,
  old_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.supplier_terms_changes TO authenticated;
GRANT ALL ON public.supplier_terms_changes TO service_role;
ALTER TABLE public.supplier_terms_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "supplier_terms_changes_select" ON public.supplier_terms_changes;
CREATE POLICY "supplier_terms_changes_select"
  ON public.supplier_terms_changes FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));
CREATE INDEX IF NOT EXISTS idx_supplier_terms_changes_supplier
  ON public.supplier_terms_changes (supplier_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.update_supplier_terms(
  p_supplier_id uuid,
  p_default_currency text DEFAULT NULL,
  p_default_incoterms text DEFAULT NULL,
  p_default_payment_term_id uuid DEFAULT NULL,
  p_default_lead_time_days integer DEFAULT NULL,
  p_minimum_order_value numeric DEFAULT NULL,
  p_preferred_rank integer DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v RECORD; v_old jsonb; v_new jsonb;
BEGIN
  SELECT * INTO v FROM public.suppliers WHERE id = p_supplier_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Supplier not found'); END IF;
  IF NOT public.user_has_business_access(auth.uid(), v.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;
  IF v.lifecycle_state IN ('archived', 'blocked') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Terms cannot be changed while the supplier is ' || v.lifecycle_state);
  END IF;

  v_old := jsonb_build_object(
    'default_currency', v.default_currency, 'default_incoterms', v.default_incoterms,
    'default_payment_term_id', v.default_payment_term_id,
    'default_lead_time_days', v.default_lead_time_days,
    'minimum_order_value', v.minimum_order_value, 'preferred_rank', v.preferred_rank);

  UPDATE public.suppliers
     SET default_currency        = COALESCE(NULLIF(btrim(p_default_currency), ''), default_currency),
         default_incoterms       = COALESCE(NULLIF(btrim(p_default_incoterms), ''), default_incoterms),
         default_payment_term_id = COALESCE(p_default_payment_term_id, default_payment_term_id),
         default_lead_time_days  = COALESCE(p_default_lead_time_days, default_lead_time_days),
         minimum_order_value     = COALESCE(p_minimum_order_value, minimum_order_value),
         preferred_rank          = COALESCE(p_preferred_rank, preferred_rank),
         is_preferred            = COALESCE(p_preferred_rank, preferred_rank) <= 1,
         updated_at              = now()
   WHERE id = p_supplier_id
   RETURNING jsonb_build_object(
     'default_currency', default_currency, 'default_incoterms', default_incoterms,
     'default_payment_term_id', default_payment_term_id,
     'default_lead_time_days', default_lead_time_days,
     'minimum_order_value', minimum_order_value, 'preferred_rank', preferred_rank)
   INTO v_new;

  IF v_old = v_new THEN RETURN jsonb_build_object('success', true, 'noop', true); END IF;

  INSERT INTO public.supplier_terms_changes (
    organization_id, business_id, supplier_id, changed_by, reason, old_values, new_values)
  VALUES (v.organization_id, v.business_id, p_supplier_id, auth.uid(), p_reason, v_old, v_new);

  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id, action, entity_type, entity_id,
    old_values, new_values, changes_summary)
  VALUES (v.organization_id, v.business_id, auth.uid(), 'supplier.terms_changed', 'supplier',
          p_supplier_id, v_old, v_new, 'Supplier commercial terms updated');

  RETURN jsonb_build_object('success', true, 'old_values', v_old, 'new_values', v_new);
END $$;

-- ═══ Banking: add / verify / deactivate with segregation of duties ═══════
ALTER TABLE public.supplier_bank_accounts
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_bank_primary
  ON public.supplier_bank_accounts (supplier_id, COALESCE(currency, ''))
  WHERE is_primary AND is_active;

CREATE OR REPLACE FUNCTION public.add_supplier_bank_account(
  p_supplier_id uuid, p_bank_name text, p_account_name text, p_account_number text,
  p_currency text DEFAULT NULL, p_iban text DEFAULT NULL, p_swift_bic text DEFAULT NULL,
  p_branch_code text DEFAULT NULL, p_country text DEFAULT NULL, p_is_primary boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v RECORD; v_id uuid; v_masked text;
BEGIN
  SELECT * INTO v FROM public.suppliers WHERE id = p_supplier_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Supplier not found'); END IF;
  IF NOT public.user_has_business_access(auth.uid(), v.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;
  IF COALESCE(btrim(p_account_number), '') = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Account number is required');
  END IF;

  v_masked := repeat('*', GREATEST(length(btrim(p_account_number)) - 4, 0))
              || right(btrim(p_account_number), 4);

  IF p_is_primary THEN
    UPDATE public.supplier_bank_accounts
       SET is_primary = false, updated_at = now()
     WHERE supplier_id = p_supplier_id AND is_active
       AND COALESCE(currency, '') = COALESCE(NULLIF(btrim(p_currency), ''), '');
  END IF;

  INSERT INTO public.supplier_bank_accounts (
    organization_id, business_id, supplier_id, bank_name, account_name,
    account_number_masked, iban, swift_bic, branch_code, currency, country,
    is_primary, is_verified, created_by)
  VALUES (v.organization_id, v.business_id, p_supplier_id, btrim(p_bank_name), btrim(p_account_name),
          v_masked, NULLIF(btrim(p_iban), ''), NULLIF(btrim(p_swift_bic), ''),
          NULLIF(btrim(p_branch_code), ''), NULLIF(btrim(p_currency), ''), NULLIF(btrim(p_country), ''),
          COALESCE(p_is_primary, false), false, auth.uid())
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (organization_id, business_id, user_id, action, entity_type,
                                 entity_id, new_values, changes_summary)
  VALUES (v.organization_id, v.business_id, auth.uid(), 'supplier.bank_account_added',
          'supplier_bank_account', v_id,
          jsonb_build_object('supplier_id', p_supplier_id, 'masked', v_masked),
          'Bank account added (unverified)');

  RETURN jsonb_build_object('success', true, 'bank_account_id', v_id);
END $$;

CREATE OR REPLACE FUNCTION public.verify_supplier_bank_account(p_bank_account_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a RECORD;
BEGIN
  SELECT * INTO a FROM public.supplier_bank_accounts WHERE id = p_bank_account_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Bank account not found'); END IF;
  IF NOT public.user_has_business_access(auth.uid(), a.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;
  IF a.is_verified THEN RETURN jsonb_build_object('success', true, 'noop', true); END IF;
  IF a.created_by IS NOT NULL AND a.created_by = auth.uid() THEN
    RETURN jsonb_build_object('success', false,
      'error', 'Bank details must be verified by someone other than the person who entered them');
  END IF;

  UPDATE public.supplier_bank_accounts
     SET is_verified = true, verified_by = auth.uid(), verified_at = now(), updated_at = now()
   WHERE id = p_bank_account_id;

  INSERT INTO public.audit_logs (organization_id, business_id, user_id, action, entity_type,
                                 entity_id, new_values, changes_summary)
  VALUES (a.organization_id, a.business_id, auth.uid(), 'supplier.bank_account_verified',
          'supplier_bank_account', p_bank_account_id,
          jsonb_build_object('supplier_id', a.supplier_id), 'Bank account verified');

  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.deactivate_supplier_bank_account(
  p_bank_account_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a RECORD;
BEGIN
  SELECT * INTO a FROM public.supplier_bank_accounts WHERE id = p_bank_account_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Bank account not found'); END IF;
  IF NOT public.user_has_business_access(auth.uid(), a.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;
  IF NOT a.is_active THEN RETURN jsonb_build_object('success', true, 'noop', true); END IF;

  UPDATE public.supplier_bank_accounts
     SET is_active = false, is_primary = false, deactivated_at = now(), updated_at = now()
   WHERE id = p_bank_account_id;

  INSERT INTO public.audit_logs (organization_id, business_id, user_id, action, entity_type,
                                 entity_id, new_values, changes_summary)
  VALUES (a.organization_id, a.business_id, auth.uid(), 'supplier.bank_account_deactivated',
          'supplier_bank_account', p_bank_account_id,
          jsonb_build_object('supplier_id', a.supplier_id, 'reason', p_reason),
          'Bank account deactivated');

  RETURN jsonb_build_object('success', true);
END $$;

-- Remittance resolution for AP
CREATE OR REPLACE FUNCTION public.resolve_supplier_remittance(
  p_business_id uuid, p_contact_id uuid, p_currency text DEFAULT NULL)
RETURNS TABLE (bank_account_id uuid, bank_name text, account_name text,
               account_number_masked text, iban text, swift_bic text, currency text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.id, b.bank_name, b.account_name, b.account_number_masked, b.iban, b.swift_bic, b.currency
    FROM public.supplier_bank_accounts b
    JOIN public.suppliers s ON s.id = b.supplier_id
   WHERE s.business_id = p_business_id
     AND s.contact_id = p_contact_id
     AND b.is_active AND b.is_verified
     AND (p_currency IS NULL OR b.currency IS NULL OR b.currency = p_currency)
   ORDER BY (b.currency = p_currency) DESC NULLS LAST, b.is_primary DESC, b.created_at
   LIMIT 1;
$$;

-- ═══ Compliance ══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.record_supplier_compliance_check(
  p_supplier_id uuid, p_check_kind text, p_outcome text,
  p_reference text DEFAULT NULL, p_details jsonb DEFAULT '{}'::jsonb,
  p_expires_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v RECORD; v_id uuid;
BEGIN
  SELECT * INTO v FROM public.suppliers WHERE id = p_supplier_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Supplier not found'); END IF;
  IF NOT public.user_has_business_access(auth.uid(), v.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;

  INSERT INTO public.supplier_compliance_checks (
    organization_id, business_id, supplier_id, check_kind, outcome,
    checked_at, checked_by, reference, details, expires_at)
  VALUES (v.organization_id, v.business_id, p_supplier_id, p_check_kind, p_outcome,
          now(), auth.uid(), p_reference, COALESCE(p_details, '{}'::jsonb), p_expires_at)
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (organization_id, business_id, user_id, action, entity_type,
                                 entity_id, new_values, changes_summary)
  VALUES (v.organization_id, v.business_id, auth.uid(), 'supplier.compliance_check_recorded',
          'supplier', p_supplier_id,
          jsonb_build_object('check_kind', p_check_kind, 'outcome', p_outcome),
          format('Compliance check %s: %s', p_check_kind, p_outcome));

  -- A failed check holds the supplier immediately.
  IF p_outcome = 'failed' AND v.lifecycle_state IN ('draft', 'qualifying', 'approved') THEN
    PERFORM public._supplier_transition(p_supplier_id, 'suspended',
      ARRAY['draft','qualifying','approved'], 'supplier.suspended',
      format('Failed compliance check: %s', p_check_kind),
      jsonb_build_object('compliance_check_id', v_id));
  END IF;

  RETURN jsonb_build_object('success', true, 'compliance_check_id', v_id);
END $$;

-- Expiry sweep: qualification and compliance
CREATE OR REPLACE FUNCTION public.sweep_supplier_qualification_expiry()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD; v_n integer := 0;
BEGIN
  FOR r IN
    SELECT id FROM public.suppliers
     WHERE lifecycle_state = 'approved'
       AND qualification_expires_at IS NOT NULL
       AND qualification_expires_at < now()
  LOOP
    PERFORM public._supplier_transition(r.id, 'qualifying', ARRAY['approved'],
      'supplier.qualification_expired', 'Qualification validity elapsed');
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'expired', v_n);
END $$;

-- ═══ Approved supplier list ══════════════════════════════════════════════
ALTER TABLE public.supplier_categories
  ADD COLUMN IF NOT EXISTS asl_enforced boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.add_supplier_to_asl(
  p_supplier_id uuid, p_category_id uuid, p_rank integer DEFAULT 1,
  p_effective_from date DEFAULT CURRENT_DATE, p_effective_to date DEFAULT NULL,
  p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v RECORD; v_id uuid;
BEGIN
  SELECT * INTO v FROM public.suppliers WHERE id = p_supplier_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Supplier not found'); END IF;
  IF NOT public.user_has_business_access(auth.uid(), v.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;
  IF v.lifecycle_state <> 'approved' THEN
    RETURN jsonb_build_object('success', false,
      'error', 'Only approved suppliers can join the approved supplier list');
  END IF;

  INSERT INTO public.approved_supplier_list (
    organization_id, business_id, category_id, supplier_id, rank,
    approved_by, approved_at, effective_from, effective_to, notes)
  VALUES (v.organization_id, v.business_id, p_category_id, p_supplier_id,
          COALESCE(p_rank, 1), auth.uid(), now(), p_effective_from, p_effective_to, p_notes)
  ON CONFLICT (business_id, category_id, supplier_id) DO UPDATE
    SET rank = EXCLUDED.rank, effective_from = EXCLUDED.effective_from,
        effective_to = EXCLUDED.effective_to, notes = EXCLUDED.notes,
        approved_by = EXCLUDED.approved_by, approved_at = now(), updated_at = now()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'asl_id', v_id);
END $$;

CREATE OR REPLACE FUNCTION public.remove_supplier_from_asl(
  p_supplier_id uuid, p_category_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v RECORD;
BEGIN
  SELECT * INTO v FROM public.suppliers WHERE id = p_supplier_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Supplier not found'); END IF;
  IF NOT public.user_has_business_access(auth.uid(), v.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;

  DELETE FROM public.approved_supplier_list
   WHERE business_id = v.business_id AND supplier_id = p_supplier_id AND category_id = p_category_id;

  INSERT INTO public.audit_logs (organization_id, business_id, user_id, action, entity_type,
                                 entity_id, new_values, changes_summary)
  VALUES (v.organization_id, v.business_id, auth.uid(), 'supplier.asl_removed', 'supplier',
          p_supplier_id, jsonb_build_object('category_id', p_category_id, 'reason', p_reason),
          'Removed from approved supplier list');

  RETURN jsonb_build_object('success', true);
END $$;

-- ═══ Purchase gate now also enforces the ASL ═════════════════════════════
CREATE OR REPLACE FUNCTION public._assert_supplier_purchasable(
  p_vendor_contact_id uuid, p_business_id uuid, p_doc text)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE s RECORD; v_enforced boolean;
BEGIN
  IF p_vendor_contact_id IS NULL OR p_business_id IS NULL THEN RETURN; END IF;

  SELECT * INTO s FROM public.suppliers
   WHERE business_id = p_business_id AND contact_id = p_vendor_contact_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF s.lifecycle_state IN ('suspended', 'blocked', 'archived') THEN
    RAISE EXCEPTION '% cannot be raised: supplier is %', p_doc, s.lifecycle_state
      USING HINT = COALESCE(s.hold_reason, 'Reinstate the supplier first.'),
            ERRCODE = 'check_violation';
  END IF;

  IF s.category_id IS NOT NULL THEN
    SELECT asl_enforced INTO v_enforced FROM public.supplier_categories WHERE id = s.category_id;
    IF COALESCE(v_enforced, false) AND NOT EXISTS (
      SELECT 1 FROM public.approved_supplier_list a
       WHERE a.business_id = p_business_id
         AND a.supplier_id = s.id
         AND a.category_id = s.category_id
         AND (a.effective_from IS NULL OR a.effective_from <= CURRENT_DATE)
         AND (a.effective_to IS NULL OR a.effective_to >= CURRENT_DATE)
    ) THEN
      RAISE EXCEPTION '% cannot be raised: supplier is not on the approved supplier list for its category', p_doc
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END $$;