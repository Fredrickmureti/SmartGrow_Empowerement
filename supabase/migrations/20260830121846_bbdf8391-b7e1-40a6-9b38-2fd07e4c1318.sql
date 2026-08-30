CREATE OR REPLACE FUNCTION public.get_user_session_data(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- Single-institution convergence: no plan / trial / entitlement-override
-- reads. Module access is decided by RBAC; the only workspace-level gate is
-- administrative suspension. Plan-shaped keys are still emitted (as null /
-- empty) so existing clients keep parsing the payload unchanged.
DECLARE
  result jsonb;
  org_array jsonb := '[]'::jsonb;
  org_row record;
  user_count int;
  storage_used numeric;
  org_entry jsonb;
  is_admin boolean;
  role_row record;
  group_rules jsonb;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM platform_admins WHERE user_id = p_user_id AND is_active = true
  ) INTO is_admin;

  FOR org_row IN
    SELECT o.id, o.name, o.slug, o.logo_url,
           o.is_suspended, o.suspended_at, o.suspended_reason
    FROM organizations o
    JOIN user_roles ur ON ur.organization_id = o.id
    WHERE ur.user_id = p_user_id AND ur.is_active = true
    ORDER BY o.created_at ASC
  LOOP
    SELECT ur.id AS role_id, ur.role, COALESCE(ur.user_type, 'internal') AS user_type
    INTO role_row
    FROM user_roles ur
    WHERE ur.user_id = p_user_id AND ur.organization_id = org_row.id AND ur.is_active = true
    LIMIT 1;

    SELECT COUNT(DISTINCT user_id) INTO user_count
    FROM user_roles WHERE organization_id = org_row.id AND is_active = true;

    BEGIN
      SELECT COALESCE(public.get_org_storage_usage_mb(org_row.id), 0) INTO storage_used;
    EXCEPTION WHEN OTHERS THEN
      storage_used := 0;
    END;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'module', pgr.module, 'can_read', pgr.can_read, 'can_create', pgr.can_create,
      'can_write', pgr.can_write, 'can_delete', pgr.can_delete
    )), '[]'::jsonb) INTO group_rules
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = p_user_id AND mpg.organization_id = org_row.id;

    org_entry := jsonb_build_object(
      'id', org_row.id, 'name', org_row.name, 'slug', org_row.slug,
      'logo_url', org_row.logo_url,
      'subscription_plan_id', NULL,
      'subscription_status', NULL,
      'subscription_started_at', NULL,
      'subscription_ends_at', NULL,
      'trial_ends_at', NULL,
      'is_suspended', org_row.is_suspended,
      'suspended_at', org_row.suspended_at,
      'suspended_reason', org_row.suspended_reason,
      'role', COALESCE(role_row.role::text, 'staff'),
      'role_id', role_row.role_id,
      'user_type', role_row.user_type,
      'plan', NULL,
      'app_entitlements', '[]'::jsonb,
      'entitled_features', '[]'::jsonb,
      'overrides', '[]'::jsonb,
      'usage_counters', jsonb_build_object(
        'users_count', user_count,
        'storage_used_mb', storage_used
      ),
      'permission_group_rules', group_rules
    );

    org_array := org_array || jsonb_build_array(org_entry);
  END LOOP;

  result := jsonb_build_object(
    'user_id', p_user_id,
    'is_platform_admin', is_admin,
    'organizations', org_array,
    'fetched_at', now()
  );
  RETURN result;
END
$function$;