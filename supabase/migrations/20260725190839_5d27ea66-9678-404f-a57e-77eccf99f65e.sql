
-- ============================================================
-- Phase 3b — Approval engine: authority, workflow instancing,
-- replay protection, tenant isolation.
-- ============================================================

ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS rule_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS workflow_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS total_steps integer NOT NULL DEFAULT 1;

ALTER TABLE public.approval_history
  ADD COLUMN IF NOT EXISTS client_token uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_history_replay
  ON public.approval_history(request_id, step_number, client_token)
  WHERE client_token IS NOT NULL;

-- ---------- Step instances ----------
CREATE TABLE IF NOT EXISTS public.approval_request_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.approval_requests(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  step_number integer NOT NULL,
  name text,
  min_approvals integer NOT NULL DEFAULT 1,
  is_required boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending',
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, step_number)
);

GRANT SELECT ON public.approval_request_steps TO authenticated;
GRANT ALL ON public.approval_request_steps TO service_role;
ALTER TABLE public.approval_request_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_approval_request_steps_select ON public.approval_request_steps;
CREATE POLICY org_approval_request_steps_select
  ON public.approval_request_steps FOR SELECT TO authenticated
  USING (organization_id = ANY (public.get_user_organization_ids()));

-- ---------- Step approvers (authority model) ----------
CREATE TABLE IF NOT EXISTS public.approval_request_approvers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.approval_requests(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  step_number integer NOT NULL,
  principal_type text NOT NULL CHECK (principal_type IN ('user','role','group')),
  principal_user_id uuid,
  principal_role text,
  permission_group_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approval_request_approvers_req
  ON public.approval_request_approvers(request_id, step_number);
CREATE INDEX IF NOT EXISTS idx_approval_request_approvers_user
  ON public.approval_request_approvers(principal_user_id) WHERE principal_user_id IS NOT NULL;

GRANT SELECT ON public.approval_request_approvers TO authenticated;
GRANT ALL ON public.approval_request_approvers TO service_role;
ALTER TABLE public.approval_request_approvers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_approval_request_approvers_select ON public.approval_request_approvers;
CREATE POLICY org_approval_request_approvers_select
  ON public.approval_request_approvers FOR SELECT TO authenticated
  USING (organization_id = ANY (public.get_user_organization_ids()));

-- ---------- Role matching helper (safe text -> app_role) ----------
CREATE OR REPLACE FUNCTION public._approval_role_matches(_user uuid, _org uuid, _role text)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_role app_role;
BEGIN
  IF _user IS NULL OR _org IS NULL OR _role IS NULL THEN
    RETURN false;
  END IF;
  BEGIN
    v_role := _role::app_role;
  EXCEPTION WHEN OTHERS THEN
    RETURN false;
  END;
  RETURN public.has_org_role(_user, _org, v_role);
END$$;

-- ---------- Eligibility predicate ----------
CREATE OR REPLACE FUNCTION public.approval_can_decide(_request_id uuid, _user uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.approval_requests r
      JOIN public.approval_request_approvers a
        ON a.request_id = r.id
       AND a.step_number = COALESCE(r.current_step, 1)
     WHERE r.id = _request_id
       AND r.status IN ('pending','in_review','escalated')
       AND public.is_org_member(_user, r.organization_id)
       AND (
            (a.principal_type = 'user'  AND a.principal_user_id = _user)
         OR (a.principal_type = 'role'  AND public._approval_role_matches(_user, r.organization_id, a.principal_role))
         OR (a.principal_type = 'group' AND EXISTS (
               SELECT 1 FROM public.member_permission_groups m
                WHERE m.permission_group_id = a.permission_group_id
                  AND m.user_id = _user
                  AND m.organization_id = r.organization_id))
       )
  )
$$;

GRANT EXECUTE ON FUNCTION public.approval_can_decide(uuid, uuid) TO authenticated;

-- ============================================================
-- approval_route — rewritten
-- ============================================================
CREATE OR REPLACE FUNCTION public.approval_route(
  _action_key text,
  _entity_type text,
  _entity_id uuid,
  _entity_reference text DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb,
  _context jsonb DEFAULT '{}'::jsonb,
  _idempotency_key text DEFAULT NULL,
  _business_id uuid DEFAULT NULL
)
RETURNS public.approval_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user      uuid := auth.uid();
  v_org       uuid;
  v_reg       public.governance_action_registry;
  v_rule      public.approval_rules;
  v_wf        public.approval_workflows;
  v_existing  public.approval_requests;
  v_new       public.approval_requests;
  v_dedupe    text;
  v_steps     integer := 0;
  v_step      record;
  v_wf_steps  jsonb := '[]'::jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'approval_route: authentication required'
      USING ERRCODE = '42501', HINT = 'GOV_MISSING_PERMISSION';
  END IF;

  SELECT * INTO v_reg FROM public.governance_action_registry
   WHERE action_key = _action_key;
  IF v_reg IS NULL THEN
    RAISE EXCEPTION 'approval_route: unknown action_key %', _action_key
      USING ERRCODE = '22023', HINT = 'GOV_UNKNOWN_ACTION';
  END IF;

  -- Tenant resolution: caller-supplied org is honoured ONLY when the
  -- caller is an active member of it.
  v_org := NULLIF(_context ->> 'organization_id','')::uuid;
  IF v_org IS NULL THEN
    SELECT organization_id INTO v_org
      FROM public.user_roles
     WHERE user_id = v_user AND is_active = true
     ORDER BY created_at ASC
     LIMIT 1;
  END IF;
  IF v_org IS NULL OR NOT public.is_org_member(v_user, v_org) THEN
    RAISE EXCEPTION 'approval_route: caller is not a member of the target organization'
      USING ERRCODE = '42501', HINT = 'GOV_MISSING_PERMISSION';
  END IF;

  -- Replay of an explicit idempotency key returns the existing request.
  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.approval_requests
     WHERE organization_id = v_org AND idempotency_key = _idempotency_key
     LIMIT 1;
    IF v_existing.id IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- Collapse duplicate open requests for the same subject.
  SELECT * INTO v_existing FROM public.approval_requests
   WHERE organization_id = v_org
     AND action_key = _action_key
     AND entity_type = _entity_type
     AND entity_id = _entity_id
     AND status IN ('pending','in_review','escalated')
   ORDER BY created_at DESC
   LIMIT 1;
  IF v_existing.id IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- Policy evaluation. No matching active rule => approval not required.
  v_rule := public._approval_match_rule(v_org, _business_id, _entity_type, _action_key, _payload);
  IF v_rule.id IS NULL THEN
    RETURN NULL;
  END IF;

  v_dedupe := encode(
    digest(
      v_org::text || '|' || _action_key || '|' || _entity_type || '|'
        || _entity_id::text || '|' || COALESCE(_payload::text,'{}'),
      'sha256'
    ), 'hex');

  -- Workflow resolution (business-scoped preferred, highest version).
  SELECT * INTO v_wf FROM public.approval_workflows
   WHERE organization_id = v_org
     AND entity_type = _entity_type
     AND is_active = true
     AND (business_id = _business_id OR business_id IS NULL)
   ORDER BY (business_id IS NOT NULL) DESC, COALESCE(version,1) DESC
   LIMIT 1;

  IF v_wf.id IS NOT NULL THEN
    SELECT count(*) INTO v_steps
      FROM public.approval_workflow_steps s
     WHERE s.workflow_id = v_wf.id
       AND (s.action_key IS NULL OR s.action_key = _action_key);
  END IF;
  IF v_steps = 0 THEN
    v_steps := 1;   -- single implicit step derived from the rule
  END IF;

  INSERT INTO public.approval_requests(
    organization_id, business_id, workflow_id, entity_type, entity_id,
    entity_reference, current_step, total_steps, status, requested_by, requested_at,
    action_key, workflow_version, policy_version,
    payload_snapshot, context_snapshot, rule_snapshot, workflow_snapshot,
    idempotency_key, dedupe_hash
  ) VALUES (
    v_org, _business_id, v_wf.id, _entity_type, _entity_id,
    _entity_reference, 1, v_steps, 'pending', v_user, now(),
    _action_key, COALESCE(v_wf.version, 1), 1,
    COALESCE(_payload,'{}'::jsonb),
    COALESCE(_context,'{}'::jsonb),
    to_jsonb(v_rule),
    CASE WHEN v_wf.id IS NULL THEN NULL ELSE to_jsonb(v_wf) END,
    _idempotency_key, v_dedupe
  )
  RETURNING * INTO v_new;

  -- ---- Materialise steps + approvers (immutable instance) ----
  IF v_wf.id IS NOT NULL THEN
    FOR v_step IN
      SELECT row_number() OVER (ORDER BY s.step_order, s.created_at) AS n, s.*
        FROM public.approval_workflow_steps s
       WHERE s.workflow_id = v_wf.id
         AND (s.action_key IS NULL OR s.action_key = _action_key)
       ORDER BY s.step_order, s.created_at
    LOOP
      INSERT INTO public.approval_request_steps(
        request_id, organization_id, step_number, name, min_approvals, is_required)
      VALUES (v_new.id, v_org, v_step.n::int,
              COALESCE(v_step.role, 'Step ' || v_step.n::text), 1,
              COALESCE(v_step.is_required, true));

      IF v_step.approver_id IS NOT NULL THEN
        INSERT INTO public.approval_request_approvers(
          request_id, organization_id, step_number, principal_type, principal_user_id)
        VALUES (v_new.id, v_org, v_step.n::int, 'user', v_step.approver_id);
      END IF;
      IF v_step.role IS NOT NULL THEN
        INSERT INTO public.approval_request_approvers(
          request_id, organization_id, step_number, principal_type, principal_role)
        VALUES (v_new.id, v_org, v_step.n::int, 'role', v_step.role);
      END IF;

      v_wf_steps := v_wf_steps || to_jsonb(v_step);
    END LOOP;
  ELSE
    INSERT INTO public.approval_request_steps(
      request_id, organization_id, step_number, name, min_approvals)
    VALUES (v_new.id, v_org, 1, COALESCE(v_rule.description, 'Approval'),
            CASE WHEN v_rule.approval_mode = 'all' THEN 2 ELSE 1 END);

    IF v_rule.approver_user_id IS NOT NULL THEN
      INSERT INTO public.approval_request_approvers(
        request_id, organization_id, step_number, principal_type, principal_user_id)
      VALUES (v_new.id, v_org, 1, 'user', v_rule.approver_user_id);
    END IF;
    IF v_rule.approver_role IS NOT NULL THEN
      INSERT INTO public.approval_request_approvers(
        request_id, organization_id, step_number, principal_type, principal_role)
      VALUES (v_new.id, v_org, 1, 'role', v_rule.approver_role);
    END IF;
  END IF;

  -- Deterministic fallback: a step with no named principal is decided by
  -- organization owners / admins. Never leave a step unactionable.
  INSERT INTO public.approval_request_approvers(
    request_id, organization_id, step_number, principal_type, principal_role)
  SELECT v_new.id, v_org, s.step_number, 'role', r.role
    FROM public.approval_request_steps s
   CROSS JOIN (VALUES ('owner'),('admin')) AS r(role)
   WHERE s.request_id = v_new.id
     AND NOT EXISTS (
       SELECT 1 FROM public.approval_request_approvers a
        WHERE a.request_id = v_new.id AND a.step_number = s.step_number);

  IF v_wf_steps <> '[]'::jsonb THEN
    UPDATE public.approval_requests
       SET workflow_snapshot = COALESCE(workflow_snapshot,'{}'::jsonb)
                               || jsonb_build_object('steps', v_wf_steps)
     WHERE id = v_new.id
     RETURNING * INTO v_new;
  END IF;

  INSERT INTO public.approval_history(
    request_id, step_number, action, actor_user_id, event_type, payload
  ) VALUES (
    v_new.id, 1, 'routed', v_user, 'routed',
    jsonb_build_object(
      'action_key', _action_key,
      'entity_type', _entity_type,
      'entity_id',  _entity_id,
      'matched_rule_id', v_rule.id,
      'workflow_id', v_wf.id,
      'total_steps', v_steps
    )
  );

  -- Integration event. Emitted in-transaction: a failure must fail routing.
  INSERT INTO public.business_event_outbox(
    organization_id, business_id, topic, payload, status
  ) VALUES (
    v_org, _business_id, 'approval.routed',
    jsonb_build_object(
      'request_id',  v_new.id,
      'action_key',  _action_key,
      'entity_type', _entity_type,
      'entity_id',   _entity_id
    ),
    'pending'
  );

  RETURN v_new;
END$$;

-- ============================================================
-- approval_decide — rewritten
-- ============================================================
CREATE OR REPLACE FUNCTION public.approval_decide(
  _request_id uuid,
  _decision text,
  _comment text DEFAULT NULL,
  _client_token uuid DEFAULT NULL
)
RETURNS public.approval_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user      uuid := auth.uid();
  v_req       public.approval_requests;
  v_step      public.approval_request_steps;
  v_approvals integer;
  v_new_status text;
  v_terminal  boolean := false;
  v_step_no   integer;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'approval_decide: authentication required'
      USING ERRCODE = '42501', HINT = 'GOV_MISSING_PERMISSION';
  END IF;

  IF _decision NOT IN ('approve','reject','cancel') THEN
    RAISE EXCEPTION 'approval_decide: invalid decision %', _decision
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_req FROM public.approval_requests
   WHERE id = _request_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'approval_decide: request % not found', _request_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Tenant isolation.
  IF NOT public.is_org_member(v_user, v_req.organization_id) THEN
    RAISE EXCEPTION 'approval_decide: caller is not a member of this organization'
      USING ERRCODE = '42501', HINT = 'GOV_MISSING_PERMISSION';
  END IF;

  IF v_req.status IN ('approved','rejected','cancelled') THEN
    RAISE EXCEPTION 'approval_decide: request is already terminal (%)', v_req.status
      USING ERRCODE = '22023', HINT = 'GOV_TERMINAL_STATE';
  END IF;

  v_step_no := COALESCE(v_req.current_step, 1);

  -- Replay protection: same token on the same step is a no-op.
  IF _client_token IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.approval_history
     WHERE request_id = _request_id
       AND step_number = v_step_no
       AND client_token = _client_token
  ) THEN
    RETURN v_req;
  END IF;

  -- Authority. Cancel is the requester's own escape hatch; approve/reject
  -- require eligibility for the CURRENT step.
  IF _decision = 'cancel' THEN
    IF v_req.requested_by <> v_user AND NOT public.approval_can_decide(_request_id, v_user) THEN
      RAISE EXCEPTION 'approval_decide: not authorized to cancel this request'
        USING ERRCODE = '42501', HINT = 'GOV_MISSING_PERMISSION';
    END IF;
  ELSE
    IF NOT public.approval_can_decide(_request_id, v_user) THEN
      RAISE EXCEPTION 'approval_decide: you are not an approver for step %', v_step_no
        USING ERRCODE = '42501', HINT = 'GOV_NOT_APPROVER';
    END IF;
  END IF;

  -- Separation of duties: requester may never approve their own request.
  IF _decision = 'approve' AND v_req.requested_by = v_user THEN
    PERFORM public.governance_assert_not_self(
      v_user, v_user, v_req.action_key, v_req.organization_id,
      v_req.entity_type, v_req.entity_id
    );
  END IF;

  INSERT INTO public.approval_history(
    request_id, step_number, action, actor_user_id, event_type, comments, payload, client_token
  ) VALUES (
    _request_id, v_step_no, _decision, v_user, 'decision', _comment,
    jsonb_build_object('decision', _decision, 'step', v_step_no),
    _client_token
  );

  IF _decision IN ('reject','cancel') THEN
    v_new_status := CASE _decision WHEN 'reject' THEN 'rejected' ELSE 'cancelled' END;
    v_terminal := true;

    UPDATE public.approval_request_steps
       SET status = v_new_status, completed_at = now()
     WHERE request_id = _request_id AND step_number = v_step_no;
  ELSE
    SELECT * INTO v_step FROM public.approval_request_steps
     WHERE request_id = _request_id AND step_number = v_step_no;

    SELECT count(DISTINCT actor_user_id) INTO v_approvals
      FROM public.approval_history
     WHERE request_id = _request_id
       AND step_number = v_step_no
       AND action = 'approve';

    IF v_approvals < COALESCE(v_step.min_approvals, 1) THEN
      -- Quorum not yet met: request stays on this step.
      UPDATE public.approval_requests SET status = 'in_review'
       WHERE id = _request_id RETURNING * INTO v_req;
      RETURN v_req;
    END IF;

    UPDATE public.approval_request_steps
       SET status = 'approved', completed_at = now()
     WHERE request_id = _request_id AND step_number = v_step_no;

    IF v_step_no < COALESCE(v_req.total_steps, 1) THEN
      UPDATE public.approval_requests
         SET current_step = v_step_no + 1, status = 'pending'
       WHERE id = _request_id RETURNING * INTO v_req;

      INSERT INTO public.approval_history(
        request_id, step_number, action, actor_user_id, event_type, payload
      ) VALUES (
        _request_id, v_step_no + 1, 'advanced', v_user, 'step_advanced',
        jsonb_build_object('from_step', v_step_no, 'to_step', v_step_no + 1)
      );
      RETURN v_req;
    END IF;

    v_new_status := 'approved';
    v_terminal := true;
  END IF;

  UPDATE public.approval_requests
     SET status = v_new_status, completed_at = now()
   WHERE id = _request_id
   RETURNING * INTO v_req;

  IF v_terminal THEN
    INSERT INTO public.business_event_outbox(
      organization_id, business_id, topic, payload, status
    ) VALUES (
      v_req.organization_id, v_req.business_id,
      'approval.' || v_new_status,
      jsonb_build_object(
        'request_id',  v_req.id,
        'action_key',  v_req.action_key,
        'entity_type', v_req.entity_type,
        'entity_id',   v_req.entity_id,
        'decided_by',  v_user
      ),
      'pending'
    );
  END IF;

  RETURN v_req;
END$$;

-- Single entry points remain the only write path.
REVOKE INSERT, UPDATE, DELETE ON public.approval_requests FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.approval_history FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.approval_request_steps FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.approval_request_approvers FROM authenticated, anon;

DROP FUNCTION IF EXISTS public.approval_decide(uuid, text, text);
GRANT EXECUTE ON FUNCTION public.approval_route(text, text, uuid, text, jsonb, jsonb, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approval_decide(uuid, text, text, uuid) TO authenticated;
