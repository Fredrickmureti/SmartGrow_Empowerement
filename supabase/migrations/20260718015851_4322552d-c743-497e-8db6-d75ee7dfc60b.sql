
CREATE TABLE IF NOT EXISTS public.supplier_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  parent_id uuid REFERENCES public.supplier_categories(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, code)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_categories TO authenticated;
GRANT ALL ON public.supplier_categories TO service_role;
ALTER TABLE public.supplier_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "supplier_categories_business_access" ON public.supplier_categories FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));
CREATE TRIGGER trg_supplier_categories_updated_at BEFORE UPDATE ON public.supplier_categories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  category_id uuid REFERENCES public.supplier_categories(id) ON DELETE SET NULL,
  supplier_code text,
  lifecycle_state text NOT NULL DEFAULT 'draft'
    CHECK (lifecycle_state IN ('draft','qualifying','approved','suspended','blocked','archived')),
  preferred_rank int NOT NULL DEFAULT 0,
  is_preferred boolean NOT NULL DEFAULT false,
  default_currency text,
  default_incoterms text,
  default_payment_term_id uuid,
  default_lead_time_days int,
  minimum_order_value numeric,
  hold_reason text,
  qualification_score numeric,
  last_qualified_at timestamptz,
  qualification_expires_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, contact_id),
  UNIQUE (business_id, supplier_code)
);
CREATE INDEX IF NOT EXISTS idx_suppliers_business ON public.suppliers(business_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_contact ON public.suppliers(contact_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_state ON public.suppliers(business_id, lifecycle_state);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.suppliers TO authenticated;
GRANT ALL ON public.suppliers TO service_role;
ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "suppliers_business_access" ON public.suppliers FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));
CREATE TRIGGER trg_suppliers_updated_at BEFORE UPDATE ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.supplier_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  cycle_number int NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'submitted'
    CHECK (state IN ('draft','submitted','under_review','approved','rejected','expired')),
  submitted_by uuid,
  submitted_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  decision_notes text,
  score numeric,
  expires_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, cycle_number)
);
CREATE INDEX IF NOT EXISTS idx_supplier_qualifications_supplier ON public.supplier_qualifications(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_qualifications_state ON public.supplier_qualifications(business_id, state);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_qualifications TO authenticated;
GRANT ALL ON public.supplier_qualifications TO service_role;
ALTER TABLE public.supplier_qualifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "supplier_qualifications_business_access" ON public.supplier_qualifications FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));
CREATE TRIGGER trg_supplier_qualifications_updated_at BEFORE UPDATE ON public.supplier_qualifications
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.supplier_qualification_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  qualification_id uuid REFERENCES public.supplier_qualifications(id) ON DELETE SET NULL,
  document_kind text NOT NULL,
  document_name text NOT NULL,
  storage_path text,
  issued_at date,
  expires_at date,
  verified_by uuid,
  verified_at timestamptz,
  verification_state text NOT NULL DEFAULT 'pending'
    CHECK (verification_state IN ('pending','verified','rejected','expired')),
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_docs_supplier ON public.supplier_qualification_documents(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_docs_expiry ON public.supplier_qualification_documents(business_id, expires_at) WHERE expires_at IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_qualification_documents TO authenticated;
GRANT ALL ON public.supplier_qualification_documents TO service_role;
ALTER TABLE public.supplier_qualification_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "supplier_qualification_documents_business_access" ON public.supplier_qualification_documents FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));
CREATE TRIGGER trg_supplier_qualification_documents_updated_at BEFORE UPDATE ON public.supplier_qualification_documents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.supplier_compliance_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  check_kind text NOT NULL,
  outcome text NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending','pass','fail','waived')),
  checked_at timestamptz,
  checked_by uuid,
  reference text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_compliance_supplier ON public.supplier_compliance_checks(supplier_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_compliance_checks TO authenticated;
GRANT ALL ON public.supplier_compliance_checks TO service_role;
ALTER TABLE public.supplier_compliance_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "supplier_compliance_checks_business_access" ON public.supplier_compliance_checks FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));
CREATE TRIGGER trg_supplier_compliance_checks_updated_at BEFORE UPDATE ON public.supplier_compliance_checks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.supplier_bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  bank_name text NOT NULL,
  account_name text NOT NULL,
  account_number_masked text NOT NULL,
  account_number_encrypted text,
  iban text,
  swift_bic text,
  branch_code text,
  currency text,
  country text,
  is_primary boolean NOT NULL DEFAULT false,
  is_verified boolean NOT NULL DEFAULT false,
  verified_by uuid,
  verified_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_bank_supplier ON public.supplier_bank_accounts(supplier_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_bank_primary ON public.supplier_bank_accounts(supplier_id) WHERE is_primary;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_bank_accounts TO authenticated;
GRANT ALL ON public.supplier_bank_accounts TO service_role;
ALTER TABLE public.supplier_bank_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "supplier_bank_accounts_business_access" ON public.supplier_bank_accounts FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));
CREATE TRIGGER trg_supplier_bank_accounts_updated_at BEFORE UPDATE ON public.supplier_bank_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.approved_supplier_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  category_id uuid NOT NULL REFERENCES public.supplier_categories(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  rank int NOT NULL DEFAULT 0,
  approved_by uuid,
  approved_at timestamptz NOT NULL DEFAULT now(),
  effective_from date,
  effective_to date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, category_id, supplier_id)
);
CREATE INDEX IF NOT EXISTS idx_asl_category ON public.approved_supplier_list(category_id);
CREATE INDEX IF NOT EXISTS idx_asl_supplier ON public.approved_supplier_list(supplier_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.approved_supplier_list TO authenticated;
GRANT ALL ON public.approved_supplier_list TO service_role;
ALTER TABLE public.approved_supplier_list ENABLE ROW LEVEL SECURITY;
CREATE POLICY "approved_supplier_list_business_access" ON public.approved_supplier_list FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));
CREATE TRIGGER trg_approved_supplier_list_updated_at BEFORE UPDATE ON public.approved_supplier_list
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Backfill: contacts with supplier or both type become suppliers
INSERT INTO public.suppliers (organization_id, business_id, contact_id, lifecycle_state)
SELECT c.organization_id, c.business_id, c.id, 'approved'
  FROM public.contacts c
 WHERE c.type IN ('supplier','both')
   AND NOT EXISTS (SELECT 1 FROM public.suppliers s WHERE s.contact_id = c.id AND s.business_id = c.business_id);

CREATE OR REPLACE FUNCTION public.submit_supplier_qualification(p_supplier_id uuid, p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sup RECORD; v_cycle int; v_qid uuid;
BEGIN
  SELECT s.* INTO v_sup FROM public.suppliers s WHERE s.id = p_supplier_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Supplier not found'); END IF;
  IF NOT public.user_has_business_access(auth.uid(), v_sup.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;
  SELECT COALESCE(MAX(cycle_number), 0) + 1 INTO v_cycle FROM public.supplier_qualifications WHERE supplier_id = p_supplier_id;
  INSERT INTO public.supplier_qualifications (organization_id, business_id, supplier_id, cycle_number, state, submitted_by, submitted_at, payload)
  VALUES (v_sup.organization_id, v_sup.business_id, p_supplier_id, v_cycle, 'submitted', auth.uid(), now(), COALESCE(p_payload,'{}'::jsonb))
  RETURNING id INTO v_qid;
  UPDATE public.suppliers SET lifecycle_state='qualifying', updated_at=now()
   WHERE id = p_supplier_id AND lifecycle_state IN ('draft','approved','suspended');
  INSERT INTO public.business_event_outbox (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_sup.organization_id, 'supplier.qualification_submitted', 'supplier_qualification', v_qid,
          jsonb_build_object('supplier_id', p_supplier_id, 'cycle', v_cycle, 'business_id', v_sup.business_id),
          'supplier.qualification_submitted:' || v_qid::text || ':' || v_cycle::text, auth.uid(), 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('success', true, 'qualification_id', v_qid, 'cycle', v_cycle);
END $$;
GRANT EXECUTE ON FUNCTION public.submit_supplier_qualification(uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_supplier_qualification(p_qualification_id uuid, p_score numeric DEFAULT NULL, p_expires_at timestamptz DEFAULT NULL, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_q RECORD;
BEGIN
  SELECT * INTO v_q FROM public.supplier_qualifications WHERE id = p_qualification_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Qualification not found'); END IF;
  IF NOT public.user_has_business_access(auth.uid(), v_q.business_id) THEN RETURN jsonb_build_object('success', false, 'error', 'Access denied'); END IF;
  IF v_q.state NOT IN ('submitted','under_review') THEN RETURN jsonb_build_object('success', false, 'error', 'Not reviewable: '||v_q.state); END IF;
  IF v_q.submitted_by = auth.uid() THEN RETURN jsonb_build_object('success', false, 'error', 'Approver cannot equal submitter'); END IF;
  UPDATE public.supplier_qualifications SET state='approved', reviewed_by=auth.uid(), reviewed_at=now(),
         score=COALESCE(p_score, score), expires_at=COALESCE(p_expires_at, expires_at), decision_notes=p_notes, updated_at=now()
   WHERE id = p_qualification_id;
  UPDATE public.suppliers SET lifecycle_state='approved', qualification_score=COALESCE(p_score, qualification_score),
         last_qualified_at=now(), qualification_expires_at=COALESCE(p_expires_at, qualification_expires_at), updated_at=now()
   WHERE id = v_q.supplier_id;
  INSERT INTO public.business_event_outbox (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_q.organization_id, 'supplier.qualification_approved', 'supplier_qualification', p_qualification_id,
          jsonb_build_object('supplier_id', v_q.supplier_id, 'cycle', v_q.cycle_number, 'score', p_score),
          'supplier.qualification_approved:' || p_qualification_id::text, auth.uid(), 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('success', true);
END $$;
GRANT EXECUTE ON FUNCTION public.approve_supplier_qualification(uuid, numeric, timestamptz, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_supplier_qualification(p_qualification_id uuid, p_notes text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_q RECORD;
BEGIN
  SELECT * INTO v_q FROM public.supplier_qualifications WHERE id = p_qualification_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Qualification not found'); END IF;
  IF NOT public.user_has_business_access(auth.uid(), v_q.business_id) THEN RETURN jsonb_build_object('success', false, 'error', 'Access denied'); END IF;
  IF v_q.state NOT IN ('submitted','under_review') THEN RETURN jsonb_build_object('success', false, 'error', 'Not reviewable'); END IF;
  IF v_q.submitted_by = auth.uid() THEN RETURN jsonb_build_object('success', false, 'error', 'Approver cannot equal submitter'); END IF;
  UPDATE public.supplier_qualifications SET state='rejected', reviewed_by=auth.uid(), reviewed_at=now(), decision_notes=p_notes, updated_at=now()
   WHERE id = p_qualification_id;
  UPDATE public.suppliers SET lifecycle_state='draft', updated_at=now()
   WHERE id = v_q.supplier_id AND lifecycle_state='qualifying';
  INSERT INTO public.business_event_outbox (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_q.organization_id, 'supplier.qualification_rejected', 'supplier_qualification', p_qualification_id,
          jsonb_build_object('supplier_id', v_q.supplier_id, 'cycle', v_q.cycle_number, 'reason', p_notes),
          'supplier.qualification_rejected:' || p_qualification_id::text, auth.uid(), 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('success', true);
END $$;
GRANT EXECUTE ON FUNCTION public.reject_supplier_qualification(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.suspend_supplier(p_supplier_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sup RECORD;
BEGIN
  SELECT * INTO v_sup FROM public.suppliers WHERE id = p_supplier_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Supplier not found'); END IF;
  IF NOT public.user_has_business_access(auth.uid(), v_sup.business_id) THEN RETURN jsonb_build_object('success', false, 'error', 'Access denied'); END IF;
  IF v_sup.lifecycle_state = 'suspended' THEN RETURN jsonb_build_object('success', true, 'noop', true); END IF;
  UPDATE public.suppliers SET lifecycle_state='suspended', hold_reason=p_reason, updated_at=now() WHERE id = p_supplier_id;
  INSERT INTO public.business_event_outbox (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_sup.organization_id, 'supplier.suspended', 'supplier', p_supplier_id,
          jsonb_build_object('reason', p_reason, 'business_id', v_sup.business_id),
          'supplier.suspended:' || p_supplier_id::text || ':' || extract(epoch from now())::text, auth.uid(), 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('success', true);
END $$;
GRANT EXECUTE ON FUNCTION public.suspend_supplier(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reinstate_supplier(p_supplier_id uuid, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sup RECORD;
BEGIN
  SELECT * INTO v_sup FROM public.suppliers WHERE id = p_supplier_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Supplier not found'); END IF;
  IF NOT public.user_has_business_access(auth.uid(), v_sup.business_id) THEN RETURN jsonb_build_object('success', false, 'error', 'Access denied'); END IF;
  IF v_sup.lifecycle_state <> 'suspended' THEN RETURN jsonb_build_object('success', false, 'error', 'Not suspended'); END IF;
  UPDATE public.suppliers SET lifecycle_state='approved', hold_reason=NULL, updated_at=now() WHERE id = p_supplier_id;
  INSERT INTO public.business_event_outbox (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_sup.organization_id, 'supplier.reinstated', 'supplier', p_supplier_id,
          jsonb_build_object('notes', p_notes, 'business_id', v_sup.business_id),
          'supplier.reinstated:' || p_supplier_id::text || ':' || extract(epoch from now())::text, auth.uid(), 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('success', true);
END $$;
GRANT EXECUTE ON FUNCTION public.reinstate_supplier(uuid, text) TO authenticated;

COMMENT ON TABLE public.suppliers IS 'Procurement P1: first-class supplier object, 1:1 linked to contacts. Carries qualification, preferred rank, lifecycle state.';
