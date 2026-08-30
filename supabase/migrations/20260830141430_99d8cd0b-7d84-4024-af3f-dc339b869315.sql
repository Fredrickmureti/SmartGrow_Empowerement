-- 1. Neutralise platform-admin authority helpers (keeps ~103 dependent policies valid,
--    but they can never grant platform authority again).
CREATE OR REPLACE FUNCTION public.is_platform_admin(_user_id uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT false $$;

CREATE OR REPLACE FUNCTION public._user_is_active_platform_admin(p_user uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT false $$;

CREATE OR REPLACE FUNCTION public.has_platform_permission(_user_id uuid, _permission text)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT false $$;

CREATE OR REPLACE FUNCTION public.get_platform_admin_permissions(_user_id uuid)
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT ARRAY[]::text[] $$;

CREATE OR REPLACE FUNCTION public.get_platform_admin_scopes(_user_id uuid)
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT ARRAY[]::text[] $$;

CREATE OR REPLACE FUNCTION public.get_platform_admin_role(_user_id uuid)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT NULL::text $$;

-- 2. Session bootstrap without any platform-admin read.
CREATE OR REPLACE FUNCTION public.get_user_session_data(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  result jsonb;
  org_array jsonb := '[]'::jsonb;
  org_row record;
  user_count int;
  storage_used numeric;
  org_entry jsonb;
  role_row record;
  group_rules jsonb;
BEGIN
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
      'is_suspended', org_row.is_suspended,
      'suspended_at', org_row.suspended_at,
      'suspended_reason', org_row.suspended_reason,
      'role', COALESCE(role_row.role::text, 'staff'),
      'role_id', role_row.role_id,
      'user_type', role_row.user_type,
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
    'organizations', org_array,
    'fetched_at', now()
  );
  RETURN result;
END
$function$;

-- 3. Drop SaaS ownership-transfer and admin-only routines.
DROP FUNCTION IF EXISTS public.initiate_ownership_transfer(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.complete_ownership_transfer(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.cancel_ownership_transfer(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.prevent_owner_deactivation() CASCADE;

-- 4. Drop the platform-administration subsystem tables.
DROP TABLE IF EXISTS public.platform_admin_group_permissions CASCADE;
DROP TABLE IF EXISTS public.platform_admin_group_members CASCADE;
DROP TABLE IF EXISTS public.platform_admin_groups CASCADE;
DROP TABLE IF EXISTS public.platform_admin_country_scopes CASCADE;
DROP TABLE IF EXISTS public.platform_admin_sessions CASCADE;
DROP TABLE IF EXISTS public.platform_admin_alerts CASCADE;
DROP TABLE IF EXISTS public.platform_admin_notifications CASCADE;
DROP TABLE IF EXISTS public.platform_ownership_transfers CASCADE;
DROP TABLE IF EXISTS public.platform_permission_definitions CASCADE;
DROP TABLE IF EXISTS public.platform_automation_rules CASCADE;
DROP TABLE IF EXISTS public.platform_email_campaigns CASCADE;
DROP TABLE IF EXISTS public.platform_email_logs CASCADE;
DROP TABLE IF EXISTS public.platform_email_templates CASCADE;
DROP TABLE IF EXISTS public.platform_feature_catalog CASCADE;
DROP TABLE IF EXISTS public.demo_requests CASCADE;

-- 5. Replace platform_admins with a permanently empty read-only stand-in so the
--    remaining legacy policies and helper routines resolve without granting authority.
DROP TABLE IF EXISTS public.platform_admins CASCADE;

CREATE VIEW public.platform_admins
WITH (security_invoker = true) AS
SELECT
  NULL::uuid        AS id,
  NULL::uuid        AS user_id,
  NULL::timestamptz AS granted_at,
  NULL::uuid        AS granted_by,
  NULL::boolean     AS is_active,
  NULL::text        AS notes,
  NULL::text        AS role,
  NULL::text        AS invited_email,
  NULL::timestamptz AS invited_at,
  NULL::timestamptz AS accepted_at,
  NULL::timestamptz AS deactivated_at,
  NULL::uuid        AS deactivated_by,
  NULL::text        AS invitation_token,
  NULL::text        AS invitation_status
WHERE false;

GRANT SELECT ON public.platform_admins TO authenticated, anon, service_role;

DROP TYPE IF EXISTS public.platform_admin_role CASCADE;