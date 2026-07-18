
-- =========================================================================
-- P3: Purchase Requisitions
-- =========================================================================

-- 1. purchase_requisitions -----------------------------------------------
CREATE TABLE IF NOT EXISTS public.purchase_requisitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  requisition_number text NOT NULL,
  requester_id uuid NOT NULL,
  cost_center text,
  project_id uuid,
  need_by_date date,
  justification text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','approved','rejected','sourcing','ordered','closed','cancelled')),
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high','urgent')),
  currency text NOT NULL DEFAULT 'USD',
  estimated_total numeric(18,4) NOT NULL DEFAULT 0,
  submitted_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  rejected_by uuid,
  rejected_at timestamptz,
  rejected_reason text,
  cancelled_by uuid,
  cancelled_at timestamptz,
  closed_at timestamptz,
  notes text,
  is_sample_data boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, requisition_number)
);
CREATE INDEX IF NOT EXISTS purchase_requisitions_business_status_idx
  ON public.purchase_requisitions (business_id, status);
CREATE INDEX IF NOT EXISTS purchase_requisitions_requester_idx
  ON public.purchase_requisitions (requester_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_requisitions TO authenticated;
GRANT ALL ON public.purchase_requisitions TO service_role;
ALTER TABLE public.purchase_requisitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_requisitions_read ON public.purchase_requisitions
  FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY purchase_requisitions_write ON public.purchase_requisitions
  FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

-- 2. purchase_requisition_items ------------------------------------------
CREATE TABLE IF NOT EXISTS public.purchase_requisition_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id uuid NOT NULL REFERENCES public.purchase_requisitions(id) ON DELETE CASCADE,
  product_id uuid,
  description text NOT NULL,
  uom_id uuid,
  quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  estimated_unit_price numeric(18,6) NOT NULL DEFAULT 0 CHECK (estimated_unit_price >= 0),
  estimated_line_total numeric(18,4) GENERATED ALWAYS AS (quantity * estimated_unit_price) STORED,
  need_by_date date,
  suggested_supplier_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  contract_line_id uuid REFERENCES public.procurement_contract_lines(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','sourcing','ordered','partially_ordered','cancelled','closed')),
  purchase_order_item_id uuid,
  sort_order integer NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_requisition_items_req_idx
  ON public.purchase_requisition_items (requisition_id);
CREATE INDEX IF NOT EXISTS purchase_requisition_items_product_idx
  ON public.purchase_requisition_items (product_id) WHERE product_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_requisition_items TO authenticated;
GRANT ALL ON public.purchase_requisition_items TO service_role;
ALTER TABLE public.purchase_requisition_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_requisition_items_read ON public.purchase_requisition_items
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.purchase_requisitions r
                 WHERE r.id = requisition_id AND public.user_has_business_access(auth.uid(), r.business_id)));
CREATE POLICY purchase_requisition_items_write ON public.purchase_requisition_items
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.purchase_requisitions r
                 WHERE r.id = requisition_id AND public.user_has_business_access(auth.uid(), r.business_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.purchase_requisitions r
                      WHERE r.id = requisition_id AND public.user_has_business_access(auth.uid(), r.business_id)));

-- 3. purchase_requisition_approvals --------------------------------------
CREATE TABLE IF NOT EXISTS public.purchase_requisition_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id uuid NOT NULL REFERENCES public.purchase_requisitions(id) ON DELETE CASCADE,
  step_order integer NOT NULL DEFAULT 0,
  actor_user_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('submitted','approved','rejected','cancelled','reopened')),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_requisition_approvals_req_idx
  ON public.purchase_requisition_approvals (requisition_id, step_order);

GRANT SELECT, INSERT ON public.purchase_requisition_approvals TO authenticated;
GRANT ALL ON public.purchase_requisition_approvals TO service_role;
ALTER TABLE public.purchase_requisition_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_requisition_approvals_read ON public.purchase_requisition_approvals
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.purchase_requisitions r
                 WHERE r.id = requisition_id AND public.user_has_business_access(auth.uid(), r.business_id)));
CREATE POLICY purchase_requisition_approvals_insert ON public.purchase_requisition_approvals
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.purchase_requisitions r
                      WHERE r.id = requisition_id AND public.user_has_business_access(auth.uid(), r.business_id)));

-- 4. PO back-links -------------------------------------------------------
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS requisition_id uuid
    REFERENCES public.purchase_requisitions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS purchase_orders_requisition_idx
  ON public.purchase_orders (requisition_id) WHERE requisition_id IS NOT NULL;

ALTER TABLE public.purchase_order_items
  ADD COLUMN IF NOT EXISTS requisition_item_id uuid
    REFERENCES public.purchase_requisition_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS purchase_order_items_requisition_item_idx
  ON public.purchase_order_items (requisition_item_id) WHERE requisition_item_id IS NOT NULL;

-- Now that purchase_requisition_items exists, the FK can be added.
ALTER TABLE public.purchase_requisition_items
  DROP CONSTRAINT IF EXISTS purchase_requisition_items_po_item_fk;
ALTER TABLE public.purchase_requisition_items
  ADD CONSTRAINT purchase_requisition_items_po_item_fk
  FOREIGN KEY (purchase_order_item_id)
  REFERENCES public.purchase_order_items(id) ON DELETE SET NULL;

-- 5. updated_at triggers -------------------------------------------------
DROP TRIGGER IF EXISTS trg_purchase_requisitions_updated ON public.purchase_requisitions;
CREATE TRIGGER trg_purchase_requisitions_updated
  BEFORE UPDATE ON public.purchase_requisitions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_purchase_requisition_items_updated ON public.purchase_requisition_items;
CREATE TRIGGER trg_purchase_requisition_items_updated
  BEFORE UPDATE ON public.purchase_requisition_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 6. Lifecycle RPCs ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_requisition(p_requisition_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r RECORD; v_uid uuid := auth.uid(); v_total numeric;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_r FROM public.purchase_requisitions WHERE id = p_requisition_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Requisition not found'); END IF;
  IF NOT public.user_has_business_access(v_uid, v_r.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;
  IF v_r.status <> 'draft' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only draft requisitions can be submitted');
  END IF;
  SELECT coalesce(sum(estimated_line_total),0) INTO v_total
    FROM public.purchase_requisition_items WHERE requisition_id = p_requisition_id;
  IF v_total <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Requisition has no lines');
  END IF;
  UPDATE public.purchase_requisitions
     SET status='submitted', submitted_at=now(), estimated_total=v_total, updated_at=now()
   WHERE id = p_requisition_id;
  INSERT INTO public.purchase_requisition_approvals(requisition_id, step_order, actor_user_id, decision)
    VALUES (p_requisition_id, 0, v_uid, 'submitted');
  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_r.organization_id, 'procurement.requisition.submitted',
          'purchase_requisition', p_requisition_id,
          jsonb_build_object('estimated_total', v_total, 'currency', v_r.currency),
          'procurement.requisition.submitted:' || p_requisition_id::text, v_uid, 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('success', true, 'estimated_total', v_total);
END $$;

CREATE OR REPLACE FUNCTION public.approve_requisition(
  p_requisition_id uuid, p_comment text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r RECORD; v_uid uuid := auth.uid(); v_step int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_r FROM public.purchase_requisitions WHERE id = p_requisition_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Requisition not found'); END IF;
  IF NOT public.user_has_business_access(v_uid, v_r.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;
  IF v_r.status <> 'submitted' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only submitted requisitions can be approved');
  END IF;
  IF v_r.requester_id = v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'Approver cannot equal requester');
  END IF;
  SELECT coalesce(max(step_order),0)+1 INTO v_step
    FROM public.purchase_requisition_approvals WHERE requisition_id = p_requisition_id;
  UPDATE public.purchase_requisitions
     SET status='approved', approved_by=v_uid, approved_at=now(), updated_at=now()
   WHERE id = p_requisition_id;
  INSERT INTO public.purchase_requisition_approvals(requisition_id, step_order, actor_user_id, decision, comment)
    VALUES (p_requisition_id, v_step, v_uid, 'approved', p_comment);
  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_r.organization_id, 'procurement.requisition.approved',
          'purchase_requisition', p_requisition_id,
          jsonb_build_object('requester_id', v_r.requester_id),
          'procurement.requisition.approved:' || p_requisition_id::text, v_uid, 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.reject_requisition(
  p_requisition_id uuid, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r RECORD; v_uid uuid := auth.uid(); v_step int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Reason is required');
  END IF;
  SELECT * INTO v_r FROM public.purchase_requisitions WHERE id = p_requisition_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Requisition not found'); END IF;
  IF NOT public.user_has_business_access(v_uid, v_r.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;
  IF v_r.status <> 'submitted' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only submitted requisitions can be rejected');
  END IF;
  IF v_r.requester_id = v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rejector cannot equal requester');
  END IF;
  SELECT coalesce(max(step_order),0)+1 INTO v_step
    FROM public.purchase_requisition_approvals WHERE requisition_id = p_requisition_id;
  UPDATE public.purchase_requisitions
     SET status='rejected', rejected_by=v_uid, rejected_at=now(),
         rejected_reason=p_reason, updated_at=now()
   WHERE id = p_requisition_id;
  INSERT INTO public.purchase_requisition_approvals(requisition_id, step_order, actor_user_id, decision, comment)
    VALUES (p_requisition_id, v_step, v_uid, 'rejected', p_reason);
  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_r.organization_id, 'procurement.requisition.rejected',
          'purchase_requisition', p_requisition_id,
          jsonb_build_object('reason', p_reason),
          'procurement.requisition.rejected:' || p_requisition_id::text, v_uid, 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.cancel_requisition(
  p_requisition_id uuid, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r RECORD; v_uid uuid := auth.uid(); v_step int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_r FROM public.purchase_requisitions WHERE id = p_requisition_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Requisition not found'); END IF;
  IF NOT public.user_has_business_access(v_uid, v_r.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;
  IF v_r.status IN ('ordered','closed','cancelled') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Requisition already closed');
  END IF;
  SELECT coalesce(max(step_order),0)+1 INTO v_step
    FROM public.purchase_requisition_approvals WHERE requisition_id = p_requisition_id;
  UPDATE public.purchase_requisitions
     SET status='cancelled', cancelled_by=v_uid, cancelled_at=now(), updated_at=now()
   WHERE id = p_requisition_id;
  INSERT INTO public.purchase_requisition_approvals(requisition_id, step_order, actor_user_id, decision, comment)
    VALUES (p_requisition_id, v_step, v_uid, 'cancelled', p_reason);
  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_r.organization_id, 'procurement.requisition.cancelled',
          'purchase_requisition', p_requisition_id,
          jsonb_build_object('reason', p_reason),
          'procurement.requisition.cancelled:' || p_requisition_id::text, v_uid, 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('success', true);
END $$;

-- 7. Topic registry ------------------------------------------------------
INSERT INTO public.business_event_topics (topic_prefix, producer_domain, consumer_domains, description)
VALUES
  ('procurement.requisition.submitted', 'procurement', ARRAY['approvals','notifications'],
     'Requisition sent for approval.'),
  ('procurement.requisition.approved',  'procurement', ARRAY['sourcing','notifications'],
     'Requisition approved and ready for sourcing.'),
  ('procurement.requisition.rejected',  'procurement', ARRAY['notifications','audit'],
     'Requisition rejected — requester notified.'),
  ('procurement.requisition.cancelled', 'procurement', ARRAY['audit'],
     'Requisition cancelled before it became a PO.')
ON CONFLICT (topic_prefix) DO UPDATE
  SET producer_domain = EXCLUDED.producer_domain,
      consumer_domains = EXCLUDED.consumer_domains,
      description = EXCLUDED.description,
      updated_at = now();
