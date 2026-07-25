CREATE OR REPLACE FUNCTION public.governance_assert_not_self(
  p_actor uuid,
  p_subject uuid,
  p_action text,
  p_org uuid DEFAULT NULL::uuid,
  p_entity_type text DEFAULT NULL::text,
  p_entity_id uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_mode                    text;
  v_override                public.self_action_overrides;
  v_actor_role              public.app_role;
  v_org_mode                text;
  v_governance_operator_count int;
  v_policy_exists           boolean := false;
BEGIN
  IF p_actor IS NULL OR p_subject IS NULL THEN
    RETURN;
  END IF;

  IF p_actor <> p_subject THEN
    RETURN;
  END IF;

  IF p_org IS NOT NULL AND public._is_teardown_for_org(p_org) THEN
    RETURN;
  END IF;

  IF p_org IS NOT NULL THEN
    SELECT ur.role INTO v_actor_role
      FROM public.user_roles ur
     WHERE ur.user_id = p_actor
       AND ur.organization_id = p_org
       AND ur.is_active = true
     ORDER BY CASE ur.role
       WHEN 'super_admin' THEN 0
       WHEN 'owner'       THEN 1
       WHEN 'admin'       THEN 2
       ELSE 9
     END
     LIMIT 1;

    SELECT governance_mode INTO v_org_mode
      FROM public.organizations
     WHERE id = p_org;
    v_org_mode := COALESCE(v_org_mode, 'standard');

    IF v_org_mode = 'solo' AND v_actor_role IN ('super_admin', 'owner', 'admin') THEN
      SELECT count(DISTINCT user_id) INTO v_governance_operator_count
        FROM public.user_roles
       WHERE organization_id = p_org
         AND is_active = true
         AND role IN ('super_admin', 'owner', 'admin');

      INSERT INTO public.audit_logs(organization_id, user_id, action, entity_type, entity_id, new_values)
      VALUES (
        p_org,
        p_actor,
        'sod.self_action_auto_allowed',
        COALESCE(p_entity_type, 'unknown'),
        p_entity_id,
        jsonb_build_object(
          'action_key', p_action,
          'reason', 'solo_governance_mode',
          'governance_mode', v_org_mode,
          'actor_role', v_actor_role,
          'governance_operator_count', COALESCE(v_governance_operator_count, 0)
        )
      );
      RETURN;
    END IF;

    SELECT mode INTO v_mode
      FROM public.self_action_policy
     WHERE organization_id = p_org
       AND action_key = p_action
       AND (applies_to_role = v_actor_role OR applies_to_role IS NULL)
     ORDER BY (applies_to_role IS NULL) ASC
     LIMIT 1;

    v_policy_exists := v_mode IS NOT NULL;

    IF v_mode IS NULL THEN
      IF v_org_mode = 'standard' THEN
        IF v_actor_role IN ('owner', 'super_admin', 'admin') THEN
          v_mode := 'warn';
        ELSE
          v_mode := 'block';
        END IF;
      ELSE
        v_mode := 'block';
      END IF;
    END IF;
  END IF;

  v_mode := COALESCE(v_mode, 'block');

  IF v_mode = 'allow' THEN
    RETURN;
  END IF;

  IF v_mode = 'warn' THEN
    IF p_org IS NOT NULL THEN
      INSERT INTO public.audit_logs(organization_id, user_id, action, entity_type, entity_id, new_values)
      VALUES (
        p_org,
        p_actor,
        'sod.self_action_warn',
        COALESCE(p_entity_type, 'unknown'),
        p_entity_id,
        jsonb_build_object(
          'action_key', p_action,
          'subject', p_subject,
          'source', CASE WHEN v_policy_exists THEN 'policy' ELSE 'mode_default' END
        )
      );
    END IF;
    RETURN;
  END IF;

  IF p_org IS NOT NULL THEN
    SELECT * INTO v_override
      FROM public.self_action_overrides o
     WHERE o.organization_id = p_org
       AND o.actor_user_id = p_actor
       AND o.subject_user_id = p_subject
       AND o.action_key = p_action
       AND (p_entity_id IS NULL OR o.entity_id IS NULL OR o.entity_id = p_entity_id)
       AND o.expires_at > now()
       AND o.consumed_at IS NULL
     ORDER BY o.created_at DESC
     LIMIT 1
     FOR UPDATE;

    IF FOUND THEN
      PERFORM set_config('app.self_action_consume', 'true', true);
      UPDATE public.self_action_overrides
         SET consumed_at = now(),
             consumed_entity_id = p_entity_id
       WHERE id = v_override.id;
      PERFORM set_config('app.self_action_consume', 'false', true);

      INSERT INTO public.audit_logs(organization_id, user_id, action, entity_type, entity_id, new_values)
      VALUES (
        p_org,
        p_actor,
        'sod.self_action_override_consumed',
        COALESCE(p_entity_type, 'unknown'),
        p_entity_id,
        jsonb_build_object('action_key', p_action, 'override_id', v_override.id)
      );
      RETURN;
    END IF;
  END IF;

  RAISE EXCEPTION 'Self-approval blocked for action "%".', p_action
    USING ERRCODE = '42501', HINT = 'GOV_SELF_ACTION';
END;
$function$;