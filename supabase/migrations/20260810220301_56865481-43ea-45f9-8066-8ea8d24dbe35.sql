CREATE OR REPLACE FUNCTION public.governance_assert_not_self(
  p_actor uuid,
  p_subject uuid,
  p_action text,
  p_org uuid DEFAULT NULL,
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_mode text;
  v_override public.self_action_overrides;
  v_actor_role public.app_role;
  v_org_mode text;
  v_governance_operator_count integer;
  v_policy_exists boolean := false;
BEGIN
  IF p_actor IS NULL OR p_subject IS NULL OR p_actor <> p_subject THEN RETURN; END IF;
  IF p_org IS NOT NULL AND public._is_teardown_for_org(p_org) THEN RETURN; END IF;

  IF p_org IS NOT NULL THEN
    SELECT ur.role INTO v_actor_role
      FROM public.user_roles ur
     WHERE ur.user_id = p_actor AND ur.organization_id = p_org AND ur.is_active = true
     ORDER BY CASE ur.role WHEN 'super_admin' THEN 0 WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 9 END
     LIMIT 1;

    SELECT governance_mode INTO v_org_mode FROM public.organizations WHERE id = p_org;
    v_org_mode := COALESCE(v_org_mode, 'standard');

    -- Explicit per-action/per-role policy is the highest-priority rule in every tier.
    SELECT mode INTO v_mode
      FROM public.self_action_policy
     WHERE organization_id = p_org
       AND action_key = p_action
       AND (applies_to_role = v_actor_role OR applies_to_role IS NULL)
     ORDER BY (applies_to_role IS NULL) ASC
     LIMIT 1;
    v_policy_exists := v_mode IS NOT NULL;

    IF v_mode IS NULL AND v_org_mode = 'solo'
       AND v_actor_role IN ('super_admin', 'owner', 'admin') THEN
      SELECT count(DISTINCT user_id) INTO v_governance_operator_count
        FROM public.user_roles
       WHERE organization_id = p_org AND is_active = true
         AND role IN ('super_admin', 'owner', 'admin');
      INSERT INTO public.audit_logs(organization_id,user_id,action,entity_type,entity_id,new_values)
      VALUES (p_org,p_actor,'sod.self_action_auto_allowed',COALESCE(p_entity_type,'unknown'),p_entity_id,
        jsonb_build_object('action_key',p_action,'reason','solo_governance_mode','governance_mode',v_org_mode,
                           'actor_role',v_actor_role,'governance_operator_count',COALESCE(v_governance_operator_count,0)));
      RETURN;
    END IF;

    IF v_mode IS NULL THEN
      IF v_org_mode = 'standard' AND v_actor_role IN ('owner','super_admin','admin') THEN
        v_mode := 'warn';
      ELSE
        v_mode := 'block';
      END IF;
    END IF;
  END IF;

  v_mode := COALESCE(v_mode, 'block');
  IF v_mode = 'allow' THEN RETURN; END IF;
  IF v_mode = 'warn' THEN
    IF p_org IS NOT NULL THEN
      INSERT INTO public.audit_logs(organization_id,user_id,action,entity_type,entity_id,new_values)
      VALUES (p_org,p_actor,'sod.self_action_warn',COALESCE(p_entity_type,'unknown'),p_entity_id,
        jsonb_build_object('action_key',p_action,'subject',p_subject,
                           'source',CASE WHEN v_policy_exists THEN 'policy' ELSE 'mode_default' END));
    END IF;
    RETURN;
  END IF;

  IF p_org IS NOT NULL THEN
    SELECT * INTO v_override FROM public.self_action_overrides o
     WHERE o.organization_id = p_org AND o.actor_user_id = p_actor
       AND o.subject_user_id = p_subject AND o.action_key = p_action
       AND (p_entity_id IS NULL OR o.entity_id IS NULL OR o.entity_id = p_entity_id)
       AND o.expires_at > now() AND o.consumed_at IS NULL
     ORDER BY o.created_at DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      PERFORM set_config('app.self_action_consume','true',true);
      UPDATE public.self_action_overrides SET consumed_at=now(),consumed_entity_id=p_entity_id WHERE id=v_override.id;
      PERFORM set_config('app.self_action_consume','false',true);
      INSERT INTO public.audit_logs(organization_id,user_id,action,entity_type,entity_id,new_values)
      VALUES (p_org,p_actor,'sod.self_action_override_consumed',COALESCE(p_entity_type,'unknown'),p_entity_id,
              jsonb_build_object('action_key',p_action,'override_id',v_override.id));
      RETURN;
    END IF;
  END IF;
  RAISE EXCEPTION 'Self-approval blocked for action "%".', p_action
    USING ERRCODE='42501', HINT='GOV_SELF_ACTION';
END;
$function$;

CREATE OR REPLACE FUNCTION public.approve_requisition(p_requisition_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_r RECORD; v_uid uuid := auth.uid(); v_step int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_r FROM public.purchase_requisitions WHERE id=p_requisition_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','Requisition not found'); END IF;
  IF NOT public.user_has_business_access(v_uid,v_r.business_id) THEN RETURN jsonb_build_object('success',false,'error','Access denied'); END IF;
  IF v_r.status <> 'submitted' THEN RETURN jsonb_build_object('success',false,'error','Only submitted requisitions can be approved'); END IF;
  IF v_r.approval_request_id IS NOT NULL THEN
    RETURN jsonb_build_object('success',false,'error','This requisition is routed through the approval engine; decide it from the approvals inbox');
  END IF;
  PERFORM public.governance_assert_not_self(v_uid,COALESCE(v_r.submitted_by,v_r.requester_id),'requisition.approve',v_r.organization_id,'purchase_requisition',v_r.id);
  SELECT coalesce(max(step_order),0)+1 INTO v_step FROM public.purchase_requisition_approvals WHERE requisition_id=p_requisition_id;
  PERFORM public._pr_lifecycle_begin();
  UPDATE public.purchase_requisitions SET status='approved',approved_by=v_uid,approved_at=now(),updated_at=now() WHERE id=p_requisition_id;
  INSERT INTO public.purchase_requisition_approvals(requisition_id,step_order,actor_user_id,decision,comment)
  VALUES (p_requisition_id,v_step,v_uid,'approved',p_comment);
  INSERT INTO public.business_event_outbox(org_id,event_type,source_doc_type,source_doc_id,payload,idempotency_key,actor_user_id,source)
  VALUES (v_r.organization_id,'procurement.requisition.approved','purchase_requisition',p_requisition_id,
          jsonb_build_object('requester_id',v_r.requester_id),
          'procurement.requisition.approved:'||p_requisition_id::text||':v'||v_r.version::text,v_uid,'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('success',true);
END $function$;

CREATE OR REPLACE FUNCTION public.rfq_approve(_rfq_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v public.rfqs; v_req public.approval_requests;
BEGIN
  v := public._rfq_guard(_rfq_id,ARRAY['pending_approval']);
  IF v.approval_request_id IS NOT NULL THEN
    SELECT * INTO v_req FROM public.approval_requests WHERE id=v.approval_request_id;
    IF v_req.id IS NOT NULL AND v_req.status IN ('pending','in_review','escalated') THEN
      RAISE EXCEPTION 'This RFQ is under governance approval request % — decide it in Approvals (approval_decide), not from the RFQ screen',v_req.id
        USING ERRCODE='42501',HINT='GOV_USE_APPROVAL_ENGINE';
    END IF;
  END IF;
  PERFORM public.governance_assert_not_self(auth.uid(),v.submitted_by,'rfq.approve',v.organization_id,'rfq',v.id);
  UPDATE public.rfqs SET status='approved',approved_by=auth.uid(),approved_at=now(),updated_at=now() WHERE id=_rfq_id;
  PERFORM public._rfq_emit(v,'rfq.approved','{}'::jsonb,auth.uid());
  RETURN jsonb_build_object('success',true,'status','approved');
END $function$;

CREATE OR REPLACE FUNCTION public.approve_purchase_order(p_po_id uuid)
RETURNS public.purchase_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_uid uuid := auth.uid(); r public.purchase_orders;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.purchase_orders WHERE id=p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF NOT public.user_has_business_access(v_uid,r.business_id) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF lower(coalesce(r.status::text,'')) NOT IN ('draft','submitted') THEN RAISE EXCEPTION 'Purchase order is %, cannot approve',r.status USING ERRCODE='22023'; END IF;
  PERFORM public.governance_assert_not_self(v_uid,COALESCE(r.submitted_by,r.created_by),'purchase_order.approve',r.organization_id,'purchase_order',r.id);
  UPDATE public.purchase_orders SET status='approved',approved_by=v_uid,approved_at=now(),updated_at=now() WHERE id=p_po_id RETURNING * INTO r;
  PERFORM public._emit_po_outbox(r.business_id,r.id,'approved',jsonb_build_object('po_number',r.po_number,'approved_by',v_uid,'total',r.total));
  RETURN r;
END $function$;

CREATE OR REPLACE FUNCTION public.approve_bill_atomic(_bill_id uuid, _actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_bill RECORD; v_block boolean; v_exception text; v_actor uuid := COALESCE(auth.uid(),_actor);
BEGIN
  IF v_actor IS NULL OR (_actor IS NOT NULL AND auth.uid() IS NOT NULL AND _actor <> auth.uid()) THEN
    RAISE EXCEPTION 'Invalid approval actor' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_bill FROM public.bills WHERE id=_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  IF v_bill.status='approved'::public.bill_status THEN RETURN jsonb_build_object('success',true,'status','approved','already',true); END IF;
  IF v_bill.status NOT IN ('draft'::public.bill_status,'submitted'::public.bill_status) THEN
    RAISE EXCEPTION 'Only draft or submitted bills can be approved (bill % is %)',v_bill.bill_number,v_bill.status;
  END IF;
  PERFORM public.governance_assert_not_self(v_actor,v_bill.created_by,'bill.approve',v_bill.organization_id,'bill',v_bill.id);
  SELECT COALESCE(b.block_bill_approval_on_match_exception,true) INTO v_block FROM public.businesses b WHERE b.id=v_bill.business_id;
  IF COALESCE(v_block,true) THEN
    SELECT r.match_state::text INTO v_exception FROM public.bill_match_results r
     WHERE r.bill_id=_bill_id AND r.exception_state='pending_review'::public.bill_match_exception_state
     ORDER BY r.matched_at DESC NULLS LAST LIMIT 1;
    IF v_exception IS NOT NULL THEN
      RAISE EXCEPTION 'Bill % has an unresolved match discrepancy (%). Resolve the exception before approving.',v_bill.bill_number,v_exception USING ERRCODE='check_violation';
    END IF;
  END IF;
  UPDATE public.bills SET status='approved'::public.bill_status,approved_by=v_actor,approved_at=now(),updated_at=now() WHERE id=_bill_id;
  RETURN jsonb_build_object('success',true,'status','approved','bill_number',v_bill.bill_number);
END $function$;

CREATE OR REPLACE FUNCTION public.rfq_award(_rfq_id uuid,_awards jsonb,_justification text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v public.rfqs; a jsonb; l jsonb; q public.rfq_quotations; v_award_id uuid;
  v_total numeric; v_awarded_lines int:=0; v_demand int; v_covered int; v_grand numeric:=0;
  v_req public.approval_requests;
BEGIN
  v:=public._rfq_guard(_rfq_id,ARRAY['responses_received','under_evaluation','sent']);
  IF _justification IS NULL OR btrim(_justification)='' THEN RAISE EXCEPTION 'An award justification is required'; END IF;
  IF jsonb_array_length(COALESCE(_awards,'[]'::jsonb))=0 THEN RAISE EXCEPTION 'Nothing to award'; END IF;
  IF EXISTS(SELECT 1 FROM public.rfq_awards WHERE rfq_id=_rfq_id) THEN RAISE EXCEPTION 'RFQ % has already been awarded',v.rfq_number; END IF;
  PERFORM public.governance_assert_not_self(auth.uid(),v.approved_by,'rfq.award',v.organization_id,'rfq',v.id);
  PERFORM public.governance_assert_not_self(auth.uid(),v.submitted_by,'rfq.award',v.organization_id,'rfq',v.id);
  FOR a IN SELECT * FROM jsonb_array_elements(_awards) LOOP
    SELECT * INTO q FROM public.rfq_quotations WHERE id=(a->>'quotation_id')::uuid AND rfq_id=_rfq_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Quotation not found on this RFQ'; END IF;
    IF q.state<>'submitted' THEN RAISE EXCEPTION 'Quotation is % and cannot be awarded',q.state; END IF;
    INSERT INTO public.rfq_awards(rfq_id,supplier_id,quotation_id,currency,award_reason,awarded_by)
    VALUES(_rfq_id,q.supplier_id,q.id,q.currency,a->>'reason',auth.uid()) RETURNING id INTO v_award_id;
    FOR l IN SELECT * FROM jsonb_array_elements(a->'lines') LOOP
      INSERT INTO public.rfq_award_items(award_id,rfq_item_id,quotation_item_id,awarded_quantity,awarded_uom_id,unit_price,tax_rate,line_total)
      SELECT v_award_id,qi.rfq_item_id,qi.id,(l->>'awarded_quantity')::numeric,qi.quoted_uom_id,qi.unit_price,qi.tax_rate,
             round((l->>'awarded_quantity')::numeric*qi.unit_price,6)
        FROM public.rfq_quotation_items qi
       WHERE qi.id=(l->>'quotation_item_id')::uuid AND qi.quotation_id=q.id
         AND (l->>'awarded_quantity')::numeric>0 AND (l->>'awarded_quantity')::numeric<=qi.quoted_quantity;
      IF NOT FOUND THEN RAISE EXCEPTION 'Awarded quantity exceeds the quantity quoted, or the line does not belong to this quotation'; END IF;
      v_awarded_lines:=v_awarded_lines+1;
    END LOOP;
    SELECT COALESCE(sum(line_total),0) INTO v_total FROM public.rfq_award_items WHERE award_id=v_award_id;
    UPDATE public.rfq_awards SET awarded_value=v_total WHERE id=v_award_id;
    UPDATE public.rfq_quotations SET state='awarded' WHERE id=q.id;
    v_grand:=v_grand+v_total;
  END LOOP;
  UPDATE public.rfq_quotations SET state='rejected' WHERE rfq_id=_rfq_id AND state='submitted';
  SELECT count(*) INTO v_demand FROM public.rfq_items WHERE rfq_id=_rfq_id;
  SELECT count(DISTINCT ai.rfq_item_id) INTO v_covered FROM public.rfq_award_items ai JOIN public.rfq_awards aw ON aw.id=ai.award_id WHERE aw.rfq_id=_rfq_id;
  UPDATE public.rfqs SET status=CASE WHEN v_covered>=v_demand THEN 'awarded' ELSE 'partially_awarded' END,
    awarded_by=auth.uid(),awarded_at=now(),award_justification=_justification,updated_at=now() WHERE id=_rfq_id;
  v_req:=public.approval_route('rfq.award','rfq',_rfq_id,v.rfq_number,
    jsonb_build_object('amount',v_grand,'total_amount',v_grand,'currency',v.currency,'version',v.version,'message',_justification),
    jsonb_build_object('organization_id',v.organization_id),'rfq.award:'||_rfq_id::text||':v'||v.version::text,v.business_id);
  UPDATE public.rfqs SET award_approval_request_id=v_req.id,updated_at=now() WHERE id=_rfq_id;
  PERFORM public._rfq_emit(v,'rfq.awarded',jsonb_build_object('lines',v_awarded_lines,'suppliers',jsonb_array_length(_awards),
    'awarded_value',v_grand,'approval_request_id',v_req.id),auth.uid());
  RETURN jsonb_build_object('success',true,'awarded_lines',v_awarded_lines,'fully_awarded',v_covered>=v_demand,
    'awarded_value',v_grand,'approval_request_id',v_req.id,'gated',v_req.id IS NOT NULL);
END $function$;