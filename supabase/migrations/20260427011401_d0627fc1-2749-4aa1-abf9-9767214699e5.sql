CREATE OR REPLACE FUNCTION public._assert_reset_permission(org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required (no auth.uid in session) for org %', org_id
      USING ERRCODE='42501';
  END IF;

  IF NOT (
    public.is_platform_admin(v_user)
    OR public.has_role(v_user, org_id, 'super_admin'::app_role)
    OR public.has_role(v_user, org_id, 'owner'::app_role)
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions: user % is not platform admin or owner/super_admin of org %', v_user, org_id
      USING ERRCODE='42501';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.platform_delete_organization(
  p_org_id uuid,
  p_confirmation_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_expected_token text := 'DELETE-' || p_org_id::text;
  v_org_name text;
  v_reset jsonb;
  v_counts jsonb := '{}'::jsonb;
  n bigint;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
  END IF;

  IF NOT public.is_platform_admin(v_user) THEN
    RAISE EXCEPTION 'Platform admin access required' USING ERRCODE='42501';
  END IF;

  IF p_confirmation_token IS DISTINCT FROM v_expected_token THEN
    RAISE EXCEPTION 'Invalid confirmation token' USING ERRCODE='22023';
  END IF;

  SELECT name INTO v_org_name
  FROM public.organizations
  WHERE id = p_org_id;

  IF v_org_name IS NULL THEN
    RAISE EXCEPTION 'Organization not found' USING ERRCODE='P0002';
  END IF;

  v_reset := public.reset_organization_data(p_org_id, 'RESET-' || p_org_id::text);

  PERFORM set_config('app.reset_in_progress', p_org_id::text, true);

  WITH d AS (DELETE FROM public.webhook_events WHERE organization_id = p_org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v_counts := v_counts || jsonb_build_object('webhook_events', n);

  WITH d AS (DELETE FROM public.platform_admin_alerts WHERE organization_id = p_org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v_counts := v_counts || jsonb_build_object('platform_admin_alerts', n);

  WITH d AS (DELETE FROM public.je_number_sequences WHERE organization_id = p_org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v_counts := v_counts || jsonb_build_object('je_number_sequences', n);

  INSERT INTO public.admin_audit_log (action_type, admin_user_id, target_org_id, target_entity_type, target_entity_id, details)
  VALUES (
    'platform_organization_delete',
    v_user,
    p_org_id,
    'organization',
    p_org_id,
    jsonb_build_object(
      'organization_name', v_org_name,
      'deleted_at', now(),
      'reset_result', v_reset,
      'platform_leftovers', v_counts
    )
  );

  DELETE FROM public.organizations WHERE id = p_org_id;

  RETURN jsonb_build_object(
    'success', true,
    'organization_id', p_org_id,
    'organization_name', v_org_name,
    'reset_result', v_reset,
    'platform_leftovers', v_counts
  );
END;
$function$;