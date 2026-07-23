CREATE OR REPLACE FUNCTION public.garnishment_transition(
  p_garnishment_id uuid,
  p_action text,
  p_reason_code text DEFAULT NULL::text,
  p_reason_text text DEFAULT NULL::text,
  p_evidence_url text DEFAULT NULL::text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS public.employee_garnishments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.employee_garnishments;
  v_from public.garnishment_status;
  v_to   public.garnishment_status;
  v_actor uuid := auth.uid();
  v_action_key text;
  v_has_workflow boolean;
  v_workflow_id uuid;
  v_has_open_request boolean;
  v_has_approved_request boolean;
  v_role_ok boolean;
BEGIN
  SELECT * INTO v_row FROM public.employee_garnishments WHERE id = p_garnishment_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'GARNISHMENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  v_role_ok := public.has_role(v_actor, 'admin')
            OR public.has_role(v_actor, 'owner')
            OR public.has_role(v_actor, 'accountant')
            OR public.has_role(v_actor, 'super_admin');
  IF p_action IN ('suspend','resume') THEN
    v_role_ok := v_role_ok OR public.has_role(v_actor, 'manager');
  END IF;
  IF NOT v_role_ok THEN
    RAISE EXCEPTION 'GARNISHMENT_FORBIDDEN: missing required role for %', p_action
      USING ERRCODE = '42501', HINT = 'GOV_MISSING_PERMISSION';
  END IF;

  v_action_key := 'payroll.legal_order.' || p_action;
  BEGIN
    PERFORM public.governance_assert_not_subject(
      v_actor,
      v_row.employee_id,
      v_action_key,
      v_row.organization_id,
      'legal_order',
      v_row.id
    );
  EXCEPTION WHEN undefined_function THEN
    NULL;
  END;

  IF p_action IN ('activate','release','terminate_unsatisfied') THEN
    SELECT id INTO v_workflow_id FROM public.approval_workflows aw
     WHERE aw.organization_id = v_row.organization_id
       AND aw.entity_type = 'legal_order'
     LIMIT 1;
    v_has_workflow := v_workflow_id IS NOT NULL;

    IF v_has_workflow THEN
      SELECT EXISTS (
        SELECT 1 FROM public.approval_requests ar
         WHERE ar.organization_id = v_row.organization_id
           AND ar.entity_type = 'legal_order'
           AND ar.entity_id   = v_row.id
           AND ar.status      = 'approved'
      ) INTO v_has_approved_request;

      IF NOT v_has_approved_request THEN
        RAISE EXCEPTION 'GARNISHMENT_APPROVAL_REQUIRED: action % needs an approved workflow request', p_action
          USING ERRCODE = '42501', HINT = 'GOV_APPROVER_REQUIRED';
      END IF;
    END IF;
  END IF;

  v_from := v_row.status;
  v_to := CASE
    WHEN p_action = 'submit'                 AND v_from = 'draft'            THEN 'pending_approval'::public.garnishment_status
    WHEN p_action = 'approve'                AND v_from = 'pending_approval' THEN 'approved'::public.garnishment_status
    WHEN p_action = 'reject'                 AND v_from = 'pending_approval' THEN 'draft'::public.garnishment_status
    WHEN p_action = 'activate'               AND v_from IN ('draft','approved') THEN 'active'::public.garnishment_status
    WHEN p_action = 'suspend'                AND v_from = 'active'           THEN 'suspended'::public.garnishment_status
    WHEN p_action = 'resume'                 AND v_from = 'suspended'        THEN 'active'::public.garnishment_status
    WHEN p_action = 'mark_satisfied'         AND v_from IN ('active','suspended') THEN 'satisfied'::public.garnishment_status
    WHEN p_action = 'release'                AND v_from IN ('active','suspended') THEN 'released'::public.garnishment_status
    WHEN p_action = 'expire'                 AND v_from IN ('active','suspended') THEN 'expired'::public.garnishment_status
    WHEN p_action = 'terminate_unsatisfied'  AND v_from IN ('active','suspended') THEN 'terminated_unsatisfied'::public.garnishment_status
  END;
  IF v_to IS NULL THEN
    RAISE EXCEPTION 'GARNISHMENT_INVALID_TRANSITION: % from %', p_action, v_from
      USING ERRCODE = '22023';
  END IF;

  IF p_action = 'activate' AND v_row.start_date IS NOT NULL AND v_row.start_date > current_date THEN
    RAISE EXCEPTION 'GARNISHMENT_FUTURE_DATED: cannot activate before start_date %', v_row.start_date
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.employee_garnishments
     SET status = v_to,
         status_changed_at = now(),
         status_changed_by = v_actor,
         status_reason = COALESCE(p_reason_text, p_reason_code),
         is_active = (v_to = 'active'),
         document_url = COALESCE(p_evidence_url, document_url),
         updated_at = now()
   WHERE id = p_garnishment_id
   RETURNING * INTO v_row;

  -- Phase 6c/Step B: on submit, auto-create a pending approval request if a
  -- workflow exists and none is open yet, so activation later finds it.
  IF p_action = 'submit' THEN
    SELECT id INTO v_workflow_id FROM public.approval_workflows aw
     WHERE aw.organization_id = v_row.organization_id
       AND aw.entity_type = 'legal_order'
       AND aw.is_active = true
     ORDER BY aw.created_at DESC
     LIMIT 1;
    IF v_workflow_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.approval_requests ar
         WHERE ar.organization_id = v_row.organization_id
           AND ar.entity_type = 'legal_order'
           AND ar.entity_id   = v_row.id
           AND ar.status IN ('pending','approved')
      ) INTO v_has_open_request;
      IF NOT v_has_open_request THEN
        INSERT INTO public.approval_requests(
          organization_id, business_id, workflow_id, entity_type, entity_id,
          entity_reference, current_step, status, requested_by, requested_at, notes
        ) VALUES (
          v_row.organization_id, v_row.business_id, v_workflow_id, 'legal_order', v_row.id,
          COALESCE(v_row.case_reference, v_row.id::text), 1, 'pending', v_actor, now(),
          COALESCE(p_reason_text, 'Auto-created on legal-order submit')
        );
      END IF;
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.business_event_outbox(
      organization_id, business_id, event_type, aggregate_type, aggregate_id, payload, status
    ) VALUES (
      v_row.organization_id, v_row.business_id,
      'legal_order.' || p_action, 'legal_order', v_row.id,
      jsonb_build_object(
        'from', v_from, 'to', v_to,
        'reason_code', p_reason_code, 'reason_text', p_reason_text,
        'evidence_url', p_evidence_url, 'actor', v_actor, 'payload', p_payload
      ),
      'pending'
    );
  EXCEPTION WHEN undefined_table THEN NULL; END;

  RETURN v_row;
END;
$function$;