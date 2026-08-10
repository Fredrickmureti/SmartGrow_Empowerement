ALTER TABLE public.purchase_requisitions
  ADD COLUMN IF NOT EXISTS analytic_account_id uuid REFERENCES public.analytic_accounts(id),
  ADD COLUMN IF NOT EXISTS destination_branch_id uuid,
  ADD COLUMN IF NOT EXISTS destination_warehouse_id uuid,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS approval_request_id uuid,
  ADD COLUMN IF NOT EXISTS submitted_by uuid;

ALTER TABLE public.purchase_requisition_items
  ADD COLUMN IF NOT EXISTS destination_branch_id uuid,
  ADD COLUMN IF NOT EXISTS destination_warehouse_id uuid,
  ADD COLUMN IF NOT EXISTS quantity_ordered numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity_received numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity_cancelled numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_non_catalog boolean GENERATED ALWAYS AS (product_id IS NULL) STORED;

CREATE OR REPLACE FUNCTION public._pr_lifecycle_begin()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN PERFORM set_config('app.pr_lifecycle','on',true); END $$;

CREATE OR REPLACE FUNCTION public._pr_lifecycle_active()
RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT coalesce(current_setting('app.pr_lifecycle', true),'') = 'on'
$$;

CREATE OR REPLACE FUNCTION public._pr_guard_header()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF public._pr_lifecycle_active() THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Only draft requisitions can be deleted' USING ERRCODE='42501';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.rejected_by IS DISTINCT FROM OLD.rejected_by
     OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
     OR NEW.rejected_reason IS DISTINCT FROM OLD.rejected_reason
     OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
     OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
     OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
     OR NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.estimated_total IS DISTINCT FROM OLD.estimated_total
     OR NEW.requisition_number IS DISTINCT FROM OLD.requisition_number
     OR NEW.requester_id IS DISTINCT FROM OLD.requester_id THEN
    RAISE EXCEPTION 'Requisition lifecycle fields are managed by procurement functions only' USING ERRCODE='42501';
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft requisitions can be edited' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pr_guard_header ON public.purchase_requisitions;
CREATE TRIGGER trg_pr_guard_header
  BEFORE UPDATE OR DELETE ON public.purchase_requisitions
  FOR EACH ROW EXECUTE FUNCTION public._pr_guard_header();

CREATE OR REPLACE FUNCTION public._pr_guard_item()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_status text; v_req uuid;
BEGIN
  IF public._pr_lifecycle_active() THEN
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_req := CASE WHEN TG_OP='DELETE' THEN OLD.requisition_id ELSE NEW.requisition_id END;
  SELECT status INTO v_status FROM public.purchase_requisitions WHERE id = v_req;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Requisition lines can only be changed while the requisition is a draft' USING ERRCODE='42501';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

DROP TRIGGER IF EXISTS trg_pr_guard_item ON public.purchase_requisition_items;
CREATE TRIGGER trg_pr_guard_item
  BEFORE INSERT OR UPDATE OR DELETE ON public.purchase_requisition_items
  FOR EACH ROW EXECUTE FUNCTION public._pr_guard_item();

DROP POLICY IF EXISTS purchase_requisitions_write ON public.purchase_requisitions;
DROP POLICY IF EXISTS purchase_requisitions_insert ON public.purchase_requisitions;
DROP POLICY IF EXISTS purchase_requisitions_update ON public.purchase_requisitions;
DROP POLICY IF EXISTS purchase_requisitions_delete ON public.purchase_requisitions;
CREATE POLICY purchase_requisitions_insert ON public.purchase_requisitions
  FOR INSERT TO authenticated
  WITH CHECK (user_has_business_access(auth.uid(), business_id) AND requester_id = auth.uid());
CREATE POLICY purchase_requisitions_update ON public.purchase_requisitions
  FOR UPDATE TO authenticated
  USING (user_has_business_access(auth.uid(), business_id) AND requester_id = auth.uid() AND status = 'draft')
  WITH CHECK (user_has_business_access(auth.uid(), business_id) AND requester_id = auth.uid());
CREATE POLICY purchase_requisitions_delete ON public.purchase_requisitions
  FOR DELETE TO authenticated
  USING (user_has_business_access(auth.uid(), business_id) AND requester_id = auth.uid() AND status = 'draft');

DROP POLICY IF EXISTS purchase_requisition_items_write ON public.purchase_requisition_items;
CREATE POLICY purchase_requisition_items_write ON public.purchase_requisition_items
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.purchase_requisitions r
                  WHERE r.id = requisition_id
                    AND user_has_business_access(auth.uid(), r.business_id)
                    AND r.requester_id = auth.uid() AND r.status = 'draft'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.purchase_requisitions r
                  WHERE r.id = requisition_id
                    AND user_has_business_access(auth.uid(), r.business_id)
                    AND r.requester_id = auth.uid() AND r.status = 'draft'));

INSERT INTO public.governance_action_registry
  (action_key, module, subject_table, subject_mode, label, description, severity_default, is_active, requires_approval_always)
SELECT 'requisition.approve', module, 'purchase_requisitions', subject_mode,
       'Approve purchase requisition',
       'Authorises internal spend demand before sourcing (RFQ or purchase order).',
       severity_default, true, false
  FROM public.governance_action_registry WHERE action_key = 'rfq.approve'
ON CONFLICT (action_key) DO NOTHING;

INSERT INTO public.governance_duties (duty_code, label, domain, description) VALUES
  ('requisition.create', 'Create purchase requisition', 'procurement', 'Raises internal purchase demand.'),
  ('requisition.approve', 'Approve purchase requisition', 'procurement', 'Authorises internal purchase demand.')
ON CONFLICT (duty_code) DO NOTHING;

INSERT INTO public.governance_sod_conflicts (duty_a, duty_b, severity, rationale)
SELECT 'requisition.approve', 'requisition.create', 'high',
       'The requester of a purchase requisition must not approve their own demand.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.governance_sod_conflicts
   WHERE duty_a = 'requisition.approve' AND duty_b = 'requisition.create');

CREATE OR REPLACE FUNCTION public.create_purchase_requisition(
  p_business_id uuid,
  p_need_by_date date DEFAULT NULL,
  p_priority text DEFAULT 'normal',
  p_currency text DEFAULT NULL,
  p_cost_center text DEFAULT NULL,
  p_justification text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_lines jsonb DEFAULT '[]'::jsonb,
  p_analytic_account_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL,
  p_destination_branch_id uuid DEFAULT NULL,
  p_destination_warehouse_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid; v_req_id uuid; v_req_no text; v_line jsonb; v_sort int := 0; v_ccy text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF NOT public.user_has_business_access(v_uid, p_business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  SELECT organization_id, COALESCE(base_currency, 'USD') INTO v_org, v_ccy
    FROM public.businesses WHERE id = p_business_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Business not found' USING ERRCODE='22023'; END IF;

  PERFORM public._pr_lifecycle_begin();
  v_req_no := public.get_next_requisition_number(v_org, p_business_id);
  INSERT INTO public.purchase_requisitions(
    organization_id, business_id, requisition_number, requester_id,
    cost_center, analytic_account_id, project_id,
    destination_branch_id, destination_warehouse_id,
    need_by_date, justification, notes, status, priority, currency, estimated_total
  ) VALUES (
    v_org, p_business_id, v_req_no, v_uid,
    p_cost_center, p_analytic_account_id, p_project_id,
    p_destination_branch_id, p_destination_warehouse_id,
    p_need_by_date, p_justification, p_notes,
    'draft', COALESCE(p_priority,'normal'), v_ccy, 0
  ) RETURNING id INTO v_req_id;

  IF p_lines IS NOT NULL AND jsonb_array_length(p_lines) > 0 THEN
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
      v_sort := v_sort + 1;
      INSERT INTO public.purchase_requisition_items(
        requisition_id, product_id, description, uom_id, quantity,
        estimated_unit_price, need_by_date, suggested_supplier_id, contract_line_id,
        destination_branch_id, destination_warehouse_id, status, sort_order, notes
      ) VALUES (
        v_req_id,
        NULLIF(v_line->>'product_id','')::uuid,
        COALESCE(v_line->>'description',''),
        NULLIF(v_line->>'uom_id','')::uuid,
        COALESCE((v_line->>'quantity')::numeric, 0),
        COALESCE((v_line->>'estimated_unit_price')::numeric, 0),
        NULLIF(v_line->>'need_by_date','')::date,
        NULLIF(v_line->>'suggested_supplier_id','')::uuid,
        NULLIF(v_line->>'contract_line_id','')::uuid,
        COALESCE(NULLIF(v_line->>'destination_branch_id','')::uuid, p_destination_branch_id),
        COALESCE(NULLIF(v_line->>'destination_warehouse_id','')::uuid, p_destination_warehouse_id),
        'open', v_sort, NULLIF(v_line->>'notes','')
      );
    END LOOP;
  END IF;
  RETURN v_req_id;
END $$;

CREATE OR REPLACE FUNCTION public.submit_requisition(p_requisition_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_r RECORD; v_uid uuid := auth.uid(); v_total numeric; v_req public.approval_requests;
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

  PERFORM public._pr_lifecycle_begin();
  UPDATE public.purchase_requisitions
     SET status='submitted', submitted_at=now(), submitted_by=v_uid,
         estimated_total=v_total, updated_at=now()
   WHERE id = p_requisition_id;

  v_req := public.approval_route(
    'requisition.approve', 'purchase_requisition', p_requisition_id, v_r.requisition_number,
    jsonb_build_object('amount', v_total, 'total_amount', v_total, 'currency', v_r.currency,
                       'priority', v_r.priority, 'cost_center', v_r.cost_center,
                       'analytic_account_id', v_r.analytic_account_id,
                       'project_id', v_r.project_id, 'version', v_r.version),
    jsonb_build_object('organization_id', v_r.organization_id),
    'requisition.approve:' || p_requisition_id::text || ':v' || v_r.version::text,
    v_r.business_id);

  IF v_req.id IS NOT NULL THEN
    UPDATE public.purchase_requisitions
       SET approval_request_id = v_req.id, updated_at = now()
     WHERE id = p_requisition_id;
  END IF;

  INSERT INTO public.purchase_requisition_approvals(requisition_id, step_order, actor_user_id, decision)
    VALUES (p_requisition_id, 0, v_uid, 'submitted');
  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_r.organization_id, 'procurement.requisition.submitted',
          'purchase_requisition', p_requisition_id,
          jsonb_build_object('estimated_total', v_total, 'currency', v_r.currency,
                             'approval_request_id', v_req.id),
          'procurement.requisition.submitted:' || p_requisition_id::text || ':v' || v_r.version::text,
          v_uid, 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object('success', true, 'estimated_total', v_total,
                            'approval_request_id', v_req.id, 'gated', v_req.id IS NOT NULL);
END $$;

CREATE OR REPLACE FUNCTION public.approve_requisition(p_requisition_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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
  IF v_r.requester_id = v_uid OR v_r.submitted_by = v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'Segregation of duties: the requester cannot approve their own requisition');
  END IF;
  IF v_r.approval_request_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error',
      'This requisition is routed through the approval engine; decide it from the approvals inbox');
  END IF;

  SELECT coalesce(max(step_order),0)+1 INTO v_step
    FROM public.purchase_requisition_approvals WHERE requisition_id = p_requisition_id;
  PERFORM public._pr_lifecycle_begin();
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
          'procurement.requisition.approved:' || p_requisition_id::text || ':v' || v_r.version::text,
          v_uid, 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.reject_requisition(p_requisition_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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
  IF v_r.approval_request_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error',
      'This requisition is routed through the approval engine; decide it from the approvals inbox');
  END IF;
  SELECT coalesce(max(step_order),0)+1 INTO v_step
    FROM public.purchase_requisition_approvals WHERE requisition_id = p_requisition_id;
  PERFORM public._pr_lifecycle_begin();
  UPDATE public.purchase_requisitions
     SET status='draft', submitted_at=NULL, submitted_by=NULL,
         rejected_by=v_uid, rejected_at=now(), rejected_reason=p_reason, updated_at=now()
   WHERE id = p_requisition_id;
  INSERT INTO public.purchase_requisition_approvals(requisition_id, step_order, actor_user_id, decision, comment)
    VALUES (p_requisition_id, v_step, v_uid, 'rejected', p_reason);
  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_r.organization_id, 'procurement.requisition.rejected',
          'purchase_requisition', p_requisition_id,
          jsonb_build_object('reason', p_reason),
          'procurement.requisition.rejected:' || p_requisition_id::text || ':v' || v_r.version::text,
          v_uid, 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.cancel_requisition(p_requisition_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_r RECORD; v_uid uuid := auth.uid(); v_step int; v_ordered int;
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
  SELECT count(*) INTO v_ordered FROM public.purchase_requisition_items
   WHERE requisition_id = p_requisition_id AND quantity_ordered > 0;
  IF v_ordered > 0 THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Lines are already on a purchase order; cancel the purchase order first');
  END IF;
  SELECT coalesce(max(step_order),0)+1 INTO v_step
    FROM public.purchase_requisition_approvals WHERE requisition_id = p_requisition_id;
  PERFORM public._pr_lifecycle_begin();
  UPDATE public.purchase_requisitions
     SET status='cancelled', cancelled_by=v_uid, cancelled_at=now(), updated_at=now()
   WHERE id = p_requisition_id;
  UPDATE public.purchase_requisition_items
     SET status='cancelled', updated_at=now()
   WHERE requisition_id = p_requisition_id AND status NOT IN ('cancelled','closed');
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

CREATE OR REPLACE FUNCTION public._mirror_approval_to_requisition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_r public.purchase_requisitions; v_actor uuid; v_step int;
BEGIN
  IF NEW.entity_type <> 'purchase_requisition' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  SELECT * INTO v_r FROM public.purchase_requisitions WHERE id = NEW.entity_id;
  IF v_r.id IS NULL OR v_r.status <> 'submitted' THEN RETURN NEW; END IF;

  SELECT h.actor_user_id INTO v_actor
    FROM public.approval_history h
   WHERE h.request_id = NEW.id AND h.actor_user_id IS NOT NULL
   ORDER BY h.created_at DESC LIMIT 1;
  v_actor := COALESCE(auth.uid(), v_actor);

  SELECT coalesce(max(step_order),0)+1 INTO v_step
    FROM public.purchase_requisition_approvals WHERE requisition_id = v_r.id;

  PERFORM public._pr_lifecycle_begin();
  IF NEW.status = 'approved' THEN
    UPDATE public.purchase_requisitions
       SET status='approved', approved_by=v_actor, approved_at=now(), updated_at=now()
     WHERE id = v_r.id;
    INSERT INTO public.purchase_requisition_approvals(requisition_id, step_order, actor_user_id, decision, comment)
      VALUES (v_r.id, v_step, v_actor, 'approved', 'Approved via governance engine');
    INSERT INTO public.business_event_outbox
      (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
    VALUES (v_r.organization_id, 'procurement.requisition.approved',
            'purchase_requisition', v_r.id,
            jsonb_build_object('approval_request_id', NEW.id),
            'procurement.requisition.approved:' || v_r.id::text || ':v' || v_r.version::text,
            v_actor, 'procurement')
    ON CONFLICT (idempotency_key) DO NOTHING;
  ELSIF NEW.status IN ('rejected','cancelled') THEN
    UPDATE public.purchase_requisitions
       SET status='draft', submitted_at=NULL, submitted_by=NULL,
           approval_request_id=NULL, rejected_by=v_actor, rejected_at=now(),
           rejected_reason=COALESCE(v_r.rejected_reason, 'Rejected via governance engine'),
           updated_at=now()
     WHERE id = v_r.id;
    INSERT INTO public.purchase_requisition_approvals(requisition_id, step_order, actor_user_id, decision, comment)
      VALUES (v_r.id, v_step, v_actor, 'rejected', 'Rejected via governance engine');
    INSERT INTO public.business_event_outbox
      (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
    VALUES (v_r.organization_id, 'procurement.requisition.rejected',
            'purchase_requisition', v_r.id,
            jsonb_build_object('approval_request_id', NEW.id, 'status', NEW.status),
            'procurement.requisition.rejected:' || v_r.id::text || ':v' || v_r.version::text,
            v_actor, 'procurement')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_mirror_approval_to_requisition ON public.approval_requests;
CREATE TRIGGER trg_mirror_approval_to_requisition
  AFTER INSERT OR UPDATE ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION public._mirror_approval_to_requisition();