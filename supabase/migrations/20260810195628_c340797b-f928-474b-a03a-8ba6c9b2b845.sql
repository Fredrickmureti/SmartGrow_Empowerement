-- ===========================================================================
-- RFQ approvals -> canonical Governance & Approval engine
--
-- GUARD RAIL FOR FUTURE MAINTAINERS:
--   This system has EXACTLY ONE approval engine:
--     public.approval_route(...) / public.approval_decide(...)
--     backed by governance_action_registry + approval_rules + approval_workflows
--     (configured at /settings/workspace > Governance).
--   DO NOT create another approval/governance engine, table set, or
--   module-local threshold check. Register an action key instead.
-- ===========================================================================

INSERT INTO public.governance_action_registry(
  action_key, module, subject_table, subject_mode, label, description,
  severity_default, is_active, requires_approval_always)
VALUES (
  'rfq.approve', 'Purchasing', 'rfqs', 'actor', 'Approve RFQ',
  'Approve a request for quotation before it is released to suppliers.',
  'high', true, false)
ON CONFLICT (action_key) DO UPDATE
  SET module = EXCLUDED.module,
      subject_table = EXCLUDED.subject_table,
      label = EXCLUDED.label,
      description = EXCLUDED.description,
      is_active = true;

-- --------------------------------------------------------------------------
-- Submit: set pending_approval, then route through the governance engine.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rfq_submit_for_approval(_rfq_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v public.rfqs;
  n int;
  v_req public.approval_requests;
  v_total numeric := 0;
BEGIN
  v := _rfq_guard(_rfq_id, ARRAY['draft']);
  SELECT count(*) INTO n FROM rfq_items WHERE rfq_id = _rfq_id;
  IF n = 0 THEN RAISE EXCEPTION 'An RFQ needs at least one line'; END IF;
  SELECT count(*) INTO n FROM rfq_invitations WHERE rfq_id = _rfq_id AND rfq_version = v.version;
  IF n = 0 THEN RAISE EXCEPTION 'Invite at least one supplier before submitting'; END IF;

  SELECT COALESCE(sum(COALESCE(quantity,0) * COALESCE(target_price,0)), 0)
    INTO v_total FROM rfq_items WHERE rfq_id = _rfq_id;

  UPDATE rfqs SET status = 'pending_approval', submitted_by = auth.uid(),
    submitted_at = now(), updated_at = now() WHERE id = _rfq_id;

  -- Canonical engine. Returns NULL when policy does not gate this action.
  v_req := public.approval_route(
    'rfq.approve', 'rfq', _rfq_id, v.rfq_number,
    jsonb_build_object('amount', v_total, 'total_amount', v_total,
                       'currency', v.currency, 'version', v.version),
    jsonb_build_object('organization_id', v.organization_id),
    'rfq.approve:' || _rfq_id::text || ':v' || v.version::text,
    v.business_id);

  IF v_req.id IS NOT NULL THEN
    UPDATE rfqs SET approval_request_id = v_req.id, updated_at = now() WHERE id = _rfq_id;
  END IF;

  PERFORM _rfq_emit(v, 'rfq.submitted',
    jsonb_build_object('approval_request_id', v_req.id), auth.uid());

  RETURN jsonb_build_object('success', true, 'status', 'pending_approval',
                            'approval_request_id', v_req.id,
                            'gated', v_req.id IS NOT NULL);
END;
$function$;

COMMENT ON FUNCTION public.rfq_submit_for_approval(uuid) IS
  'Routes the RFQ through the single canonical governance engine (approval_route). Never add a module-local approval engine.';

-- --------------------------------------------------------------------------
-- Approve: only allowed when governance did not gate the RFQ.
-- Gated RFQs must be decided via approval_decide (mirrored below).
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rfq_approve(_rfq_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v public.rfqs;
  v_req public.approval_requests;
BEGIN
  v := _rfq_guard(_rfq_id, ARRAY['pending_approval']);

  IF v.approval_request_id IS NOT NULL THEN
    SELECT * INTO v_req FROM public.approval_requests WHERE id = v.approval_request_id;
    IF v_req.id IS NOT NULL AND v_req.status IN ('pending','in_review','escalated') THEN
      RAISE EXCEPTION 'This RFQ is under governance approval request % — decide it in Approvals (approval_decide), not from the RFQ screen', v_req.id
        USING ERRCODE = '42501', HINT = 'GOV_USE_APPROVAL_ENGINE';
    END IF;
  END IF;

  IF v.submitted_by = auth.uid() THEN
    RAISE EXCEPTION 'Segregation of duties: an RFQ cannot be approved by the user who submitted it';
  END IF;

  UPDATE rfqs SET status = 'approved', approved_by = auth.uid(), approved_at = now(),
    updated_at = now() WHERE id = _rfq_id;
  PERFORM _rfq_emit(v, 'rfq.approved', '{}'::jsonb, auth.uid());
  RETURN jsonb_build_object('success', true, 'status', 'approved');
END;
$function$;

COMMENT ON FUNCTION public.rfq_approve(uuid) IS
  'Ungated fallback only. When a governance approval_request exists the decision must come from approval_decide. Do not build a parallel approval engine.';

-- --------------------------------------------------------------------------
-- Mirror governance decisions back onto the RFQ.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._mirror_approval_to_rfq()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rfq public.rfqs;
BEGIN
  IF NEW.entity_type <> 'rfq' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_rfq FROM public.rfqs WHERE id = NEW.entity_id;
  IF v_rfq.id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'approved' AND v_rfq.status = 'pending_approval' THEN
    UPDATE public.rfqs
       SET status = 'approved',
           approved_by = COALESCE(NEW.completed_by, auth.uid()),
           approved_at = now(),
           approval_request_id = NEW.id,
           updated_at = now()
     WHERE id = v_rfq.id;
    PERFORM public._rfq_emit(v_rfq, 'rfq.approved',
      jsonb_build_object('approval_request_id', NEW.id), auth.uid());
  ELSIF NEW.status IN ('rejected','cancelled') AND v_rfq.status = 'pending_approval' THEN
    UPDATE public.rfqs
       SET status = 'draft',
           submitted_by = NULL,
           submitted_at = NULL,
           approval_request_id = NULL,
           updated_at = now()
     WHERE id = v_rfq.id;
    PERFORM public._rfq_emit(v_rfq, 'rfq.rejected',
      jsonb_build_object('approval_request_id', NEW.id, 'status', NEW.status), auth.uid());
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_mirror_approval_to_rfq ON public.approval_requests;
CREATE TRIGGER trg_mirror_approval_to_rfq
AFTER UPDATE ON public.approval_requests
FOR EACH ROW EXECUTE FUNCTION public._mirror_approval_to_rfq();