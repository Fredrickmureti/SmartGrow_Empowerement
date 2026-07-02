
-- Wave H F4: server-side candidate assembly for the Employee↔User link picker.
-- Before this RPC the dialog made four separate reads (organizations,
-- user_roles, profiles, employees, platform_admins) and classified candidates
-- in the browser. That projected user identities + role labels to anyone with
-- manageEmployees. This RPC does the assembly + classification server-side
-- under SECURITY DEFINER, gated on the same HR permission the dialog already
-- enforces, and returns a masked email so the picker still disambiguates
-- without leaking full addresses.

CREATE OR REPLACE FUNCTION public.get_linkable_users_for_employee(
  p_org_id uuid,
  p_employee_id uuid
)
RETURNS TABLE(
  user_id uuid,
  display_name text,
  email_masked text,
  linkability text,        -- 'eligible' | 'blocked' | 'already_linked'
  block_reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  IF NOT public.user_has_module_permission(v_caller, p_org_id, 'hr', 'write') THEN
    RAISE EXCEPTION 'forbidden: hr.write required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH owner AS (
    SELECT owner_user_id FROM public.organizations WHERE id = p_org_id
  ),
  active_roles AS (
    SELECT ur.user_id,
           ur.role::text   AS role,
           ur.user_type::text AS user_type
    FROM public.user_roles ur
    WHERE ur.organization_id = p_org_id
      AND ur.is_active = true
  ),
  top_role AS (
    -- Highest-privilege active role per user (super_admin > owner > admin > rest)
    SELECT DISTINCT ON (user_id)
           user_id, role, user_type
    FROM active_roles
    ORDER BY user_id,
             CASE role
               WHEN 'super_admin' THEN 3
               WHEN 'owner'       THEN 2
               WHEN 'admin'       THEN 1
               ELSE 0
             END DESC
  ),
  candidates AS (
    SELECT DISTINCT user_id FROM active_roles
  ),
  linked_elsewhere AS (
    SELECT e.user_id
    FROM public.employees e
    WHERE e.organization_id = p_org_id
      AND e.user_id IS NOT NULL
      AND e.id <> p_employee_id
  ),
  pa AS (
    SELECT pa.user_id FROM public.platform_admins pa
  )
  SELECT
    c.user_id,
    COALESCE(NULLIF(p.full_name, ''), split_part(p.email, '@', 1))::text AS display_name,
    -- Mask: keep first char + domain. Enough to disambiguate, never leaks
    -- the full address.
    CASE
      WHEN p.email IS NULL OR p.email = '' THEN ''
      ELSE substring(p.email FROM 1 FOR 1) || '***@' || split_part(p.email, '@', 2)
    END::text AS email_masked,
    CASE
      WHEN (SELECT owner_user_id FROM owner) = c.user_id            THEN 'blocked'
      WHEN c.user_id IN (SELECT user_id FROM pa)                     THEN 'blocked'
      WHEN tr.role IN ('owner','admin','super_admin')                THEN 'blocked'
      WHEN tr.user_type = 'internal'                                 THEN 'blocked'
      WHEN c.user_id = v_caller                                      THEN 'blocked'
      WHEN c.user_id IN (SELECT user_id FROM linked_elsewhere)       THEN 'already_linked'
      ELSE 'eligible'
    END::text AS linkability,
    CASE
      WHEN (SELECT owner_user_id FROM owner) = c.user_id            THEN 'Workspace owner'
      WHEN c.user_id IN (SELECT user_id FROM pa)                     THEN 'Platform administrator'
      WHEN tr.role IN ('owner','admin','super_admin')                THEN 'Active ' || tr.role || ' — change role in Team & Permissions first'
      WHEN tr.user_type = 'internal'                                 THEN 'Internal user — change to portal in Team & Permissions first'
      WHEN c.user_id = v_caller                                      THEN 'This is your own account'
      WHEN c.user_id IN (SELECT user_id FROM linked_elsewhere)       THEN 'Already linked to another employee'
      ELSE NULL
    END::text AS block_reason
  FROM candidates c
  LEFT JOIN top_role tr ON tr.user_id = c.user_id
  LEFT JOIN public.profiles p ON p.user_id = c.user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_linkable_users_for_employee(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_linkable_users_for_employee(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_linkable_users_for_employee(uuid, uuid) TO service_role;
