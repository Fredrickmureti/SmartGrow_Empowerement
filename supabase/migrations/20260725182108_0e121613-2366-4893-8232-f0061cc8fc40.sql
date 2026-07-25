-- ============================================================
-- Phase 3 — Approval engine single entry points
--   approval_route(action_key, entity_type, entity_id, payload, context, idempotency_key)
--   approval_decide(request_id, decision, comment)
-- Plus write-lockdown of approval_* tables to force all traffic through
-- the two RPCs.
-- ============================================================

-- ---------- Helper: match the first active approval rule ----------
CREATE OR REPLACE FUNCTION public._approval_match_rule(
  _org uuid,
  _business uuid,
  _entity_type text,
  _action_key text,
  _payload jsonb
)
RETURNS public.approval_rules
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.approval_rules;
  v_amount numeric;
BEGIN
  FOR r IN
    SELECT * FROM public.approval_rules
     WHERE organization_id = _org
       AND (business_id = _business OR business_id IS NULL)
       AND entity_type = _entity_type
       AND action_name = _action_key
       AND is_active = true
     ORDER BY (business_id IS NOT NULL) DESC,  -- prefer business-scoped
              COALESCE(threshold_value, 0) DESC
  LOOP
    IF r.threshold_field IS NULL OR r.threshold_value IS NULL THEN
      RETURN r;
    END IF;

    BEGIN
      v_amount := (_payload ->> r.threshold_field)::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_amount := NULL;
    END;

    IF v_amount IS NULL THEN CONTINUE; END IF;

    IF (r.threshold_operator = '>='  AND v_amount >= r.threshold_value)
    OR (r.threshold_operator = '>'   AND v_amount >  r.threshold_value)
    OR (r.threshold_operator = '<='  AND v_amount <= r.threshold_value)
    OR (r.threshold_operator = '<'   AND v_amount <  r.threshold_value)
    OR (r.threshold_operator = '='   AND v_amount =  r.threshold_value)
    THEN
      RETURN r;
    END IF;
  END LOOP;
  RETURN NULL;
END$$;

-- ---------- Router: single entry point to create an approval request ----------
CREATE OR REPLACE FUNCTION public.approval_route(
  _action_key       text,
  _entity_type      text,
  _entity_id        uuid,
  _entity_reference text DEFAULT NULL,
  _payload          jsonb DEFAULT '{}'::jsonb,
  _context          jsonb DEFAULT '{}'::jsonb,
  _idempotency_key  text  DEFAULT NULL,
  _business_id      uuid  DEFAULT NULL
)
RETURNS public.approval_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user      uuid := auth.uid();
  v_org       uuid;
  v_reg       public.governance_action_registry;
  v_rule      public.approval_rules;
  v_existing  public.approval_requests;
  v_new       public.approval_requests;
  v_dedupe    text;
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

  -- Resolve org from context or membership
  v_org := NULLIF(_context ->> 'organization_id','')::uuid;
  IF v_org IS NULL THEN
    SELECT organization_id INTO v_org
      FROM public.user_organization_memberships
     WHERE user_id = v_user AND is_active = true
     ORDER BY joined_at ASC NULLS LAST
     LIMIT 1;
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'approval_route: cannot resolve organization for user'
      USING ERRCODE = '42501', HINT = 'GOV_MISSING_PERMISSION';
  END IF;

  -- Idempotency: replay of the same key returns the existing request.
  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.approval_requests
     WHERE organization_id = v_org
       AND idempotency_key = _idempotency_key
     LIMIT 1;
    IF v_existing.id IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- Deterministic dedupe when caller cannot supply an idempotency key.
  v_dedupe := encode(
    digest(
      v_org::text || '|' || _action_key || '|' || _entity_type || '|'
        || _entity_id::text || '|' || COALESCE(_payload::text,'{}'),
      'sha256'
    ), 'hex'
  );

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

  v_rule := public._approval_match_rule(v_org, _business_id, _entity_type, _action_key, _payload);

  INSERT INTO public.approval_requests(
    organization_id, business_id, workflow_id, entity_type, entity_id,
    entity_reference, current_step, status, requested_by, requested_at,
    action_key, workflow_version, policy_version,
    payload_snapshot, context_snapshot,
    idempotency_key, dedupe_hash
  ) VALUES (
    v_org, _business_id, NULL, _entity_type, _entity_id,
    _entity_reference, 1, 'pending', v_user, now(),
    _action_key, 1, 1,
    COALESCE(_payload,'{}'::jsonb),
    COALESCE(_context,'{}'::jsonb)
      || jsonb_build_object(
           'matched_rule_id', v_rule.id,
           'matched_rule_snapshot', to_jsonb(v_rule)
         ),
    _idempotency_key, v_dedupe
  )
  RETURNING * INTO v_new;

  -- Seed history with the "routed" event
  INSERT INTO public.approval_history(
    request_id, step_number, action, actor_user_id, event_type, payload
  ) VALUES (
    v_new.id, 1, 'routed', v_user, 'routed',
    jsonb_build_object(
      'action_key', _action_key,
      'entity_type', _entity_type,
      'entity_id',  _entity_id,
      'matched_rule_id', v_rule.id
    )
  );

  -- Emit business event (best-effort; outbox table exists)
  BEGIN
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
  EXCEPTION WHEN OTHERS THEN
    -- Outbox schema may vary; never break routing on emission failure.
    NULL;
  END;

  RETURN v_new;
END$$;

REVOKE ALL ON FUNCTION public.approval_route(text,text,uuid,text,jsonb,jsonb,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approval_route(text,text,uuid,text,jsonb,jsonb,text,uuid)
  TO authenticated, service_role;

-- ---------- Decide: record an approver decision ----------
CREATE OR REPLACE FUNCTION public.approval_decide(
  _request_id uuid,
  _decision   text,     -- 'approve' | 'reject' | 'cancel'
  _comment    text DEFAULT NULL
)
RETURNS public.approval_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_req  public.approval_requests;
  v_new_status text;
  v_terminal   boolean := false;
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

  IF v_req.status IN ('approved','rejected','cancelled') THEN
    RAISE EXCEPTION 'approval_decide: request is already terminal (%)', v_req.status
      USING ERRCODE = '22023', HINT = 'GOV_TERMINAL_STATE';
  END IF;

  -- Self-action guard: requester cannot self-approve.
  IF _decision = 'approve' AND v_req.requested_by = v_user THEN
    -- Delegate to the existing governance framework so mode-tier semantics
    -- and override consumption are honored.
    PERFORM public.governance_assert_not_self(
      v_user, v_user, v_req.action_key, v_req.organization_id,
      v_req.entity_type, v_req.entity_id
    );
  END IF;

  v_new_status := CASE _decision
    WHEN 'approve' THEN 'approved'
    WHEN 'reject'  THEN 'rejected'
    WHEN 'cancel'  THEN 'cancelled'
  END;
  v_terminal := true;

  UPDATE public.approval_requests
     SET status = v_new_status,
         completed_at = now()
   WHERE id = _request_id
   RETURNING * INTO v_req;

  INSERT INTO public.approval_history(
    request_id, step_number, action, actor_user_id, event_type, comments, payload
  ) VALUES (
    _request_id, COALESCE(v_req.current_step, 1), _decision, v_user,
    'decision', _comment,
    jsonb_build_object('decision', _decision, 'status', v_new_status)
  );

  -- Terminal outbox emission
  IF v_terminal THEN
    BEGIN
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
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  RETURN v_req;
END$$;

REVOKE ALL ON FUNCTION public.approval_decide(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approval_decide(uuid,text,text) TO authenticated, service_role;

-- ---------- Lock down direct writes to approval_* tables ----------
-- Regular users keep SELECT (RLS still filters), but INSERT/UPDATE/DELETE
-- must go through the SECURITY DEFINER RPCs above (or service_role).
REVOKE INSERT, UPDATE, DELETE ON public.approval_requests FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.approval_history  FROM authenticated, anon;
GRANT  SELECT                  ON public.approval_requests TO authenticated;
GRANT  SELECT                  ON public.approval_history  TO authenticated;
GRANT  ALL                     ON public.approval_requests TO service_role;
GRANT  ALL                     ON public.approval_history  TO service_role;