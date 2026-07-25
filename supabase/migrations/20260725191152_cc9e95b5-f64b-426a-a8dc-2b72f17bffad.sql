
-- ============================================================
-- Phase 4.1 — App Access migrated onto the canonical engine
-- ============================================================

ALTER TABLE public.governance_action_registry
  ADD COLUMN IF NOT EXISTS requires_approval_always boolean NOT NULL DEFAULT false;

INSERT INTO public.governance_action_registry(
  action_key, module, subject_table, subject_mode, label, description,
  severity_default, is_active, requires_approval_always
) VALUES (
  'app_access.grant', 'Platform', 'member_permission_groups', 'actor',
  'Grant app access',
  'Grant a team member access to an installed app by adding them to its permission group.',
  'standard', true, true
)
ON CONFLICT (action_key) DO UPDATE
  SET requires_approval_always = EXCLUDED.requires_approval_always,
      module = EXCLUDED.module,
      subject_table = EXCLUDED.subject_table;

-- ---- Route: honour mandatory-approval actions ----
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

  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.approval_requests
     WHERE organization_id = v_org AND idempotency_key = _idempotency_key
     LIMIT 1;
    IF v_existing.id IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

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

  v_rule := public._approval_match_rule(v_org, _business_id, _entity_type, _action_key, _payload);
  IF v_rule.id IS NULL AND NOT v_reg.requires_approval_always THEN
    -- Policy says this event is not gated. No request is created.
    RETURN NULL;
  END IF;

  v_dedupe := encode(
    digest(
      v_org::text || '|' || _action_key || '|' || _entity_type || '|'
        || _entity_id::text || '|' || COALESCE(_payload::text,'{}'),
      'sha256'
    ), 'hex');

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
    v_steps := 1;
  END IF;

  INSERT INTO public.approval_requests(
    organization_id, business_id, workflow_id, entity_type, entity_id,
    entity_reference, current_step, total_steps, status, requested_by, requested_at,
    action_key, workflow_version, policy_version,
    payload_snapshot, context_snapshot, rule_snapshot, workflow_snapshot,
    idempotency_key, dedupe_hash, notes
  ) VALUES (
    v_org, _business_id, v_wf.id, _entity_type, _entity_id,
    _entity_reference, 1, v_steps, 'pending', v_user, now(),
    _action_key, COALESCE(v_wf.version, 1), 1,
    COALESCE(_payload,'{}'::jsonb),
    COALESCE(_context,'{}'::jsonb),
    CASE WHEN v_rule.id IS NULL THEN NULL ELSE to_jsonb(v_rule) END,
    CASE WHEN v_wf.id IS NULL THEN NULL ELSE to_jsonb(v_wf) END,
    _idempotency_key, v_dedupe,
    NULLIF(_payload ->> 'message','')
  )
  RETURNING * INTO v_new;

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
    VALUES (v_new.id, v_org, 1, COALESCE(v_rule.description, v_reg.label, 'Approval'),
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

GRANT EXECUTE ON FUNCTION public.approval_route(text, text, uuid, text, jsonb, jsonb, text, uuid) TO authenticated;

-- ---- Executor: grant the app permission group on terminal approval ----
CREATE OR REPLACE FUNCTION public._exec_app_access_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_group_id uuid;
  v_app_id   text;
BEGIN
  IF NEW.action_key IS DISTINCT FROM 'app_access.grant' THEN RETURN NEW; END IF;
  IF NEW.status <> 'approved' OR OLD.status = 'approved' THEN RETURN NEW; END IF;
  IF NEW.requested_by IS NULL THEN RETURN NEW; END IF;

  v_app_id := COALESCE(NEW.entity_reference, NEW.payload_snapshot ->> 'app_id');
  IF v_app_id IS NULL THEN RETURN NEW; END IF;

  SELECT id INTO v_group_id
    FROM public.permission_groups
   WHERE organization_id = NEW.organization_id
     AND is_system = true
     AND lower(name) LIKE lower(v_app_id) || '%'
   ORDER BY created_at
   LIMIT 1;

  IF v_group_id IS NULL THEN
    INSERT INTO public.approval_history(
      request_id, step_number, action, actor_user_id, event_type, comments, payload)
    VALUES (NEW.id, COALESCE(NEW.current_step,1), 'execution_skipped', NULL, 'execution',
            'No system permission group matches app ' || v_app_id,
            jsonb_build_object('app_id', v_app_id));
    RETURN NEW;
  END IF;

  INSERT INTO public.member_permission_groups(
    organization_id, permission_group_id, user_id, business_id)
  VALUES (NEW.organization_id, v_group_id, NEW.requested_by, NEW.business_id)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.approval_history(
    request_id, step_number, action, actor_user_id, event_type, comments, payload)
  VALUES (NEW.id, COALESCE(NEW.current_step,1), 'executed', NULL, 'execution',
          'Granted app access via permission group',
          jsonb_build_object('app_id', v_app_id, 'permission_group_id', v_group_id));

  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS trg_exec_app_access_grant ON public.approval_requests;
CREATE TRIGGER trg_exec_app_access_grant
  AFTER UPDATE OF status ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION public._exec_app_access_grant();

-- ---- request_app_access now routes through the engine ----
CREATE OR REPLACE FUNCTION public.request_app_access(_app_id text, _message text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid;
  v_business uuid;
  v_req public.approval_requests;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'request_app_access: authentication required'
      USING ERRCODE = '42501', HINT = 'GOV_MISSING_PERMISSION';
  END IF;

  SELECT uab.business_id, b.organization_id INTO v_business, v_org
    FROM public.user_active_business uab
    JOIN public.businesses b ON b.id = uab.business_id
   WHERE uab.user_id = v_uid
   LIMIT 1;

  IF v_org IS NULL THEN
    SELECT organization_id INTO v_org
      FROM public.user_roles
     WHERE user_id = v_uid AND is_active = true
     ORDER BY created_at ASC
     LIMIT 1;
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'request_app_access: no active organization'
      USING ERRCODE = '42501';
  END IF;

  v_req := public.approval_route(
    'app_access.grant',
    'app_access',
    (md5(v_uid::text || '|' || _app_id))::uuid,
    _app_id,
    jsonb_build_object('app_id', _app_id, 'message', COALESCE(_message,'')),
    jsonb_build_object('organization_id', v_org),
    NULL,
    v_business
  );

  RETURN v_req.id;
END$$;

GRANT EXECUTE ON FUNCTION public.request_app_access(text, text) TO authenticated;

-- ---- Retire the bespoke app-access decision RPCs ----
DROP FUNCTION IF EXISTS public.approve_app_access_request(uuid);
DROP FUNCTION IF EXISTS public.deny_app_access_request(uuid, text);
