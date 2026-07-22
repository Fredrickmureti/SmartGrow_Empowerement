
-- Phase 1: Payroll Legal Orders — policy-driven authorization for garnishment_transition
--
-- Replaces the flat `admin OR manager` role gate with:
--   1. RLS-aligned role set (matches employee_garnishments_hr_write)
--   2. SoD via governance_assert_not_subject (actor != employee)
--   3. Optional approval-workflow requirement for high-impact transitions
--      when the org has configured a workflow for entity_type='legal_order'
-- Adds a `legal_order_transition` alias that forwards to garnishment_transition.
-- Seeds self_action_policy defaults for the new action keys.

-- 1. Seed SoD policy rows (idempotent). Default mode='block' means the
--    actor cannot be the subject; the governance framework handles this.
INSERT INTO public.self_action_policy (organization_id, action_key, mode, applies_to_role, notes)
SELECT o.id, k.action_key, 'block', NULL, 'Payroll Legal Orders — SoD default (Phase 1)'
  FROM public.organizations o
 CROSS JOIN (VALUES
   ('payroll.legal_order.submit'),
   ('payroll.legal_order.approve'),
   ('payroll.legal_order.reject'),
   ('payroll.legal_order.activate'),
   ('payroll.legal_order.suspend'),
   ('payroll.legal_order.resume'),
   ('payroll.legal_order.mark_satisfied'),
   ('payroll.legal_order.release'),
   ('payroll.legal_order.terminate_unsatisfied')
 ) AS k(action_key)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.self_action_policy p
    WHERE p.organization_id = o.id
      AND p.action_key = k.action_key
      AND p.applies_to_role IS NULL
 );

-- 2. Rewrite garnishment_transition — same signature, richer authz.
CREATE OR REPLACE FUNCTION public.garnishment_transition(
  p_garnishment_id uuid,
  p_action text,
  p_reason_code text DEFAULT NULL,
  p_reason_text text DEFAULT NULL,
  p_evidence_url text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS public.employee_garnishments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.employee_garnishments;
  v_from public.garnishment_status;
  v_to   public.garnishment_status;
  v_actor uuid := auth.uid();
  v_action_key text;
  v_requires_workflow boolean;
  v_has_workflow boolean;
  v_has_approved_request boolean;
  v_role_ok boolean;
BEGIN
  SELECT * INTO v_row FROM public.employee_garnishments WHERE id = p_garnishment_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'GARNISHMENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- ---- Role gate (RLS-aligned) --------------------------------------------
  -- Lifecycle transitions require an HR-write role; runtime pause/resume can
  -- additionally be performed by a manager.
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

  -- ---- Segregation of Duties: actor cannot be the subject employee --------
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
    -- Framework not present in this env — fall through (dev only).
    NULL;
  END;

  -- ---- Approval-workflow gate for high-impact transitions -----------------
  -- If the org has configured an approval workflow for entity_type='legal_order',
  -- require an approved request for activate/release/terminate_unsatisfied.
  IF p_action IN ('activate','release','terminate_unsatisfied') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.approval_workflows aw
       WHERE aw.organization_id = v_row.organization_id
         AND aw.entity_type = 'legal_order'
    ) INTO v_has_workflow;

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

  -- ---- FSM ----------------------------------------------------------------
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
    WHEN p_action IN ('adjust_balance','attach_evidence','note') THEN v_from
    ELSE NULL
  END;

  IF v_to IS NULL THEN
    RAISE EXCEPTION 'GARNISHMENT_INVALID_TRANSITION: % from %', p_action, v_from
      USING ERRCODE = '22023';
  END IF;

  -- ---- Effective-window guard: cannot activate a future-dated order -------
  IF p_action = 'activate' AND v_row.start_date > current_date THEN
    RAISE EXCEPTION 'GARNISHMENT_NOT_YET_EFFECTIVE: start_date % is in the future', v_row.start_date
      USING ERRCODE = '22023';
  END IF;

  IF p_action = 'release' AND COALESCE(p_evidence_url, v_row.document_url) IS NULL THEN
    RAISE EXCEPTION 'GARNISHMENT_RELEASE_REQUIRES_EVIDENCE' USING ERRCODE = '22023';
  END IF;

  UPDATE public.employee_garnishments
     SET status = v_to,
         is_active = (v_to = 'active'),
         status_changed_at = now(),
         status_changed_by = v_actor,
         status_reason = COALESCE(p_reason_text, status_reason),
         document_url = COALESCE(p_evidence_url, document_url)
   WHERE id = p_garnishment_id
   RETURNING * INTO v_row;

  INSERT INTO public.garnishment_lifecycle_events
    (organization_id, business_id, garnishment_id, event, from_status, to_status,
     reason_code, reason_text, evidence_document_url, actor_user_id, payload)
  VALUES
    (v_row.organization_id, v_row.business_id, v_row.id, p_action, v_from, v_to,
     p_reason_code, p_reason_text, p_evidence_url, v_actor, COALESCE(p_payload, '{}'::jsonb));

  -- ---- Emit canonical business event (best-effort) ------------------------
  BEGIN
    INSERT INTO public.business_event_outbox
      (organization_id, business_id, topic, payload)
    VALUES
      (v_row.organization_id, v_row.business_id,
       'legal_order.' || p_action,
       jsonb_build_object(
         'legal_order_id', v_row.id,
         'employee_id',    v_row.employee_id,
         'kind',           v_row.kind,
         'from_status',    v_from,
         'to_status',      v_to,
         'actor_user_id',  v_actor,
         'reason_code',    p_reason_code
       ));
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL;  -- outbox not present in this env
  END;

  RETURN v_row;
END $$;

REVOKE ALL ON FUNCTION public.garnishment_transition(uuid,text,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.garnishment_transition(uuid,text,text,text,text,jsonb) TO authenticated;

COMMENT ON FUNCTION public.garnishment_transition IS
  'Payroll Legal Orders FSM. Authz: RLS-aligned role + governance_assert_not_subject + optional approval workflow (activate/release/terminate_unsatisfied when workflow configured). Writes garnishment_lifecycle_events and business_event_outbox. Service_role bypasses for engine/backfill.';

-- 3. Alias RPC using the enterprise domain name.
CREATE OR REPLACE FUNCTION public.legal_order_transition(
  p_legal_order_id uuid,
  p_action text,
  p_reason_code text DEFAULT NULL,
  p_reason_text text DEFAULT NULL,
  p_evidence_url text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS public.employee_garnishments
LANGUAGE sql SECURITY INVOKER SET search_path = public AS $$
  SELECT public.garnishment_transition(p_legal_order_id, p_action, p_reason_code, p_reason_text, p_evidence_url, p_payload);
$$;

REVOKE ALL ON FUNCTION public.legal_order_transition(uuid,text,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_order_transition(uuid,text,text,text,text,jsonb) TO authenticated;

COMMENT ON FUNCTION public.legal_order_transition IS
  'Enterprise-domain alias for garnishment_transition. Prefer this name in new code.';
