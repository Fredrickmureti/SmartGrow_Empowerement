CREATE OR REPLACE FUNCTION public.governance_self_action_verdict(
  p_actor uuid, p_subject uuid, p_action text, p_org uuid, p_entity_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_mode text;
  v_actor_role public.app_role;
  v_org_mode text;
BEGIN
  IF p_actor IS NULL OR p_subject IS NULL OR p_actor <> p_subject THEN RETURN 'not_self'; END IF;
  IF p_org IS NULL THEN RETURN 'block'; END IF;
  IF public._is_teardown_for_org(p_org) THEN RETURN 'allow'; END IF;

  SELECT ur.role INTO v_actor_role
    FROM public.user_roles ur
   WHERE ur.user_id = p_actor AND ur.organization_id = p_org AND ur.is_active = true
   ORDER BY CASE ur.role WHEN 'super_admin' THEN 0 WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 9 END
   LIMIT 1;

  SELECT COALESCE(governance_mode, 'standard') INTO v_org_mode
    FROM public.organizations WHERE id = p_org;
  v_org_mode := COALESCE(v_org_mode, 'standard');

  SELECT mode INTO v_mode
    FROM public.self_action_policy
   WHERE organization_id = p_org
     AND action_key = p_action
     AND (applies_to_role = v_actor_role OR applies_to_role IS NULL)
   ORDER BY (applies_to_role IS NULL) ASC
   LIMIT 1;

  IF v_mode IS NULL AND v_org_mode = 'solo'
     AND v_actor_role IN ('super_admin', 'owner', 'admin') THEN
    RETURN 'allow';
  END IF;

  IF v_mode IS NULL THEN
    IF v_org_mode = 'standard' AND v_actor_role IN ('owner', 'super_admin', 'admin') THEN
      v_mode := 'warn';
    ELSE
      v_mode := 'block';
    END IF;
  END IF;

  IF v_mode IN ('allow', 'warn') THEN RETURN v_mode; END IF;

  IF EXISTS (
    SELECT 1 FROM public.self_action_overrides o
     WHERE o.organization_id = p_org AND o.actor_user_id = p_actor
       AND o.subject_user_id = p_subject AND o.action_key = p_action
       AND (p_entity_id IS NULL OR o.entity_id IS NULL OR o.entity_id = p_entity_id)
       AND o.expires_at > now() AND o.consumed_at IS NULL
  ) THEN
    RETURN 'override_available';
  END IF;

  RETURN 'block';
END $$;

REVOKE ALL ON FUNCTION public.governance_self_action_verdict(uuid, uuid, text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.governance_self_action_verdict(uuid, uuid, text, uuid, uuid) TO authenticated, service_role;
DROP FUNCTION IF EXISTS public.governance_self_action_verdict(uuid, uuid, text, uuid);

CREATE OR REPLACE FUNCTION public.timesheet_approval_capability(_submission_id uuid)
RETURNS TABLE(can_approve boolean, requires_override boolean, reason text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  s record;
  v_subject uuid;
  v_verdict text;
BEGIN
  IF v_uid IS NULL THEN RETURN QUERY SELECT false, false, 'not_authenticated'; RETURN; END IF;

  SELECT * INTO s FROM public.timesheet_submissions WHERE id = _submission_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, false, 'not_found'; RETURN; END IF;
  IF s.status <> 'submitted' THEN RETURN QUERY SELECT false, false, 'not_pending'; RETURN; END IF;
  IF NOT public._timesheet_can_approve(v_uid, s.employee_id) THEN
    RETURN QUERY SELECT false, false, 'not_authorized'; RETURN;
  END IF;

  SELECT user_id INTO v_subject FROM public.employees WHERE id = s.employee_id;
  v_verdict := public.governance_self_action_verdict(
    v_uid, v_subject, 'timesheet.approve', s.organization_id, s.id);

  IF v_verdict IN ('not_self', 'allow', 'warn') THEN
    RETURN QUERY SELECT true, false, v_verdict; RETURN;
  ELSIF v_verdict = 'override_available' THEN
    RETURN QUERY SELECT true, true, v_verdict; RETURN;
  END IF;

  RETURN QUERY SELECT false, true, 'self_action_blocked';
END $$;

REVOKE ALL ON FUNCTION public.timesheet_approval_capability(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.timesheet_approval_capability(uuid) TO authenticated, service_role;