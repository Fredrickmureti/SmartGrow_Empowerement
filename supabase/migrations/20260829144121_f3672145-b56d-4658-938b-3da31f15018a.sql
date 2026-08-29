-- =========================================================================
-- M3. RBAC & PIN completion
-- =========================================================================

-- 1) Access groups -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.permission_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS public.permission_group_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permission_group_id UUID NOT NULL REFERENCES public.permission_groups(id) ON DELETE CASCADE,
  module TEXT NOT NULL,
  can_read BOOLEAN NOT NULL DEFAULT false,
  can_create BOOLEAN NOT NULL DEFAULT false,
  can_write BOOLEAN NOT NULL DEFAULT false,
  can_delete BOOLEAN NOT NULL DEFAULT false,
  can_approve BOOLEAN NOT NULL DEFAULT false,
  can_post BOOLEAN NOT NULL DEFAULT false,
  can_pay BOOLEAN NOT NULL DEFAULT false,
  can_close BOOLEAN NOT NULL DEFAULT false,
  can_reverse BOOLEAN NOT NULL DEFAULT false,
  can_export BOOLEAN NOT NULL DEFAULT false,
  can_admin_override BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (permission_group_id, module)
);

CREATE TABLE IF NOT EXISTS public.member_permission_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  permission_group_id UUID NOT NULL REFERENCES public.permission_groups(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id, permission_group_id)
);

CREATE TABLE IF NOT EXISTS public.user_security_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  pin_enabled BOOLEAN NOT NULL DEFAULT false,
  biometric_enabled BOOLEAN NOT NULL DEFAULT false,
  session_timeout_minutes INTEGER NOT NULL DEFAULT 480,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_permission_groups_org ON public.permission_groups(organization_id);
CREATE INDEX IF NOT EXISTS idx_permission_group_rules_group ON public.permission_group_rules(permission_group_id);
CREATE INDEX IF NOT EXISTS idx_member_permission_groups_user ON public.member_permission_groups(user_id, organization_id);
CREATE INDEX IF NOT EXISTS idx_member_permission_groups_group ON public.member_permission_groups(permission_group_id);

-- Grants (PostgREST needs explicit privileges; RLS still applies) ---------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.permission_groups TO authenticated;
GRANT ALL ON public.permission_groups TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.permission_group_rules TO authenticated;
GRANT ALL ON public.permission_group_rules TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_permission_groups TO authenticated;
GRANT ALL ON public.member_permission_groups TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.user_security_preferences TO authenticated;
GRANT ALL ON public.user_security_preferences TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_pins TO authenticated;
GRANT ALL ON public.user_pins TO service_role;

ALTER TABLE public.permission_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permission_group_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_permission_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_security_preferences ENABLE ROW LEVEL SECURITY;

-- 2) Role helpers --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_org_admin_or_owner(_user_id UUID, _organization_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND organization_id = _organization_id
      AND role IN ('owner', 'admin', 'super_admin')
      AND is_active = true
  )
$$;

REVOKE ALL ON FUNCTION public.is_org_admin_or_owner(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_org_admin_or_owner(UUID, UUID) TO authenticated, service_role;

-- 3) RLS: access groups --------------------------------------------------
DROP POLICY IF EXISTS "Org members can view permission groups" ON public.permission_groups;
CREATE POLICY "Org members can view permission groups"
ON public.permission_groups FOR SELECT TO authenticated
USING (public.is_org_member(auth.uid(), organization_id));

DROP POLICY IF EXISTS "Admins can create permission groups" ON public.permission_groups;
CREATE POLICY "Admins can create permission groups"
ON public.permission_groups FOR INSERT TO authenticated
WITH CHECK (public.is_org_admin_or_owner(auth.uid(), organization_id));

DROP POLICY IF EXISTS "Admins can update permission groups" ON public.permission_groups;
CREATE POLICY "Admins can update permission groups"
ON public.permission_groups FOR UPDATE TO authenticated
USING (public.is_org_admin_or_owner(auth.uid(), organization_id))
WITH CHECK (public.is_org_admin_or_owner(auth.uid(), organization_id));

DROP POLICY IF EXISTS "Admins can delete non-system permission groups" ON public.permission_groups;
CREATE POLICY "Admins can delete non-system permission groups"
ON public.permission_groups FOR DELETE TO authenticated
USING (public.is_org_admin_or_owner(auth.uid(), organization_id) AND is_system = false);

DROP POLICY IF EXISTS "Org members can view permission group rules" ON public.permission_group_rules;
CREATE POLICY "Org members can view permission group rules"
ON public.permission_group_rules FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.permission_groups pg
  WHERE pg.id = permission_group_id
    AND public.is_org_member(auth.uid(), pg.organization_id)
));

DROP POLICY IF EXISTS "Admins can insert permission group rules" ON public.permission_group_rules;
CREATE POLICY "Admins can insert permission group rules"
ON public.permission_group_rules FOR INSERT TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.permission_groups pg
  WHERE pg.id = permission_group_id
    AND public.is_org_admin_or_owner(auth.uid(), pg.organization_id)
));

DROP POLICY IF EXISTS "Admins can update permission group rules" ON public.permission_group_rules;
CREATE POLICY "Admins can update permission group rules"
ON public.permission_group_rules FOR UPDATE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.permission_groups pg
  WHERE pg.id = permission_group_id
    AND public.is_org_admin_or_owner(auth.uid(), pg.organization_id)
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.permission_groups pg
  WHERE pg.id = permission_group_id
    AND public.is_org_admin_or_owner(auth.uid(), pg.organization_id)
));

DROP POLICY IF EXISTS "Admins can delete permission group rules" ON public.permission_group_rules;
CREATE POLICY "Admins can delete permission group rules"
ON public.permission_group_rules FOR DELETE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.permission_groups pg
  WHERE pg.id = permission_group_id
    AND public.is_org_admin_or_owner(auth.uid(), pg.organization_id)
));

DROP POLICY IF EXISTS "Members can view own group assignments" ON public.member_permission_groups;
CREATE POLICY "Members can view own group assignments"
ON public.member_permission_groups FOR SELECT TO authenticated
USING (user_id = auth.uid() OR public.is_org_admin_or_owner(auth.uid(), organization_id));

DROP POLICY IF EXISTS "Admins can assign permission groups" ON public.member_permission_groups;
CREATE POLICY "Admins can assign permission groups"
ON public.member_permission_groups FOR INSERT TO authenticated
WITH CHECK (public.is_org_admin_or_owner(auth.uid(), organization_id));

DROP POLICY IF EXISTS "Admins can remove permission group assignments" ON public.member_permission_groups;
CREATE POLICY "Admins can remove permission group assignments"
ON public.member_permission_groups FOR DELETE TO authenticated
USING (public.is_org_admin_or_owner(auth.uid(), organization_id));

-- 4) RLS: user security preferences and PIN ------------------------------
DROP POLICY IF EXISTS "Users manage own security preferences" ON public.user_security_preferences;
CREATE POLICY "Users manage own security preferences"
ON public.user_security_preferences FOR SELECT TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users insert own security preferences" ON public.user_security_preferences;
CREATE POLICY "Users insert own security preferences"
ON public.user_security_preferences FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users update own security preferences" ON public.user_security_preferences;
CREATE POLICY "Users update own security preferences"
ON public.user_security_preferences FOR UPDATE TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- user_pins: owner-scoped only. The hash is never compared client-side;
-- verification runs in the security-definer RPCs below.
DROP POLICY IF EXISTS "Users can view own pins" ON public.user_pins;
CREATE POLICY "Users can view own pins"
ON public.user_pins FOR SELECT TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own pins" ON public.user_pins;
CREATE POLICY "Users can insert own pins"
ON public.user_pins FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own pins" ON public.user_pins;
CREATE POLICY "Users can update own pins"
ON public.user_pins FOR UPDATE TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can delete own pins" ON public.user_pins;
CREATE POLICY "Users can delete own pins"
ON public.user_pins FOR DELETE TO authenticated
USING (user_id = auth.uid());

-- 5) Module capability resolver -----------------------------------------
CREATE OR REPLACE FUNCTION public.user_has_module_permission(
  _user_id uuid,
  _org_id uuid,
  _module text,
  _operation text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _role public.app_role;
  _user_type text;
  _group_grants boolean := false;
  _base_grants boolean := false;
BEGIN
  SELECT ur.role, ur.user_type INTO _role, _user_type
  FROM public.user_roles ur
  WHERE ur.user_id = _user_id
    AND ur.organization_id = _org_id
    AND ur.is_active = true
  LIMIT 1;

  IF _role IS NULL THEN
    RETURN false;
  END IF;

  IF _role IN ('super_admin', 'owner', 'admin') THEN
    RETURN true;
  END IF;

  _base_grants := (
    CASE
      WHEN _module = 'contacts'   AND _operation = 'read' THEN _role IN ('accountant','staff','viewer','cashier','internal')
      WHEN _module = 'contacts'   AND _operation IN ('create','write','delete') THEN _role IN ('accountant','staff','internal')
      WHEN _module = 'financials' AND _operation = 'read' THEN _role IN ('accountant','internal')
      WHEN _module = 'financials' AND _operation IN ('create','write','delete') THEN _role IN ('accountant','internal')
      WHEN _module = 'employees'  AND _operation = 'read' THEN _role IN ('accountant','internal')
      WHEN _module = 'employees'  AND _operation IN ('create','write','delete') THEN _role IN ('internal')
      WHEN _module = 'payroll'    AND _operation = 'read' THEN _role IN ('accountant','internal')
      WHEN _module = 'payroll'    AND _operation IN ('create','write','delete') THEN _role IN ('accountant','internal')
      WHEN _module = 'leave'      AND _operation = 'read' THEN true
      WHEN _module = 'leave'      AND _operation IN ('create','write','delete') THEN _role IN ('internal','accountant')
      WHEN _module = 'attendance' AND _operation = 'read' THEN true
      WHEN _module = 'attendance' AND _operation IN ('create','write','delete') THEN _role IN ('internal','accountant','staff')
      WHEN _module = 'settings'   AND _operation = 'read' THEN _role IN ('internal','accountant')
      WHEN _module = 'settings'   AND _operation IN ('create','write','delete') THEN false
      WHEN _module = 'team'       AND _operation = 'read' THEN _role IN ('internal','accountant')
      WHEN _module = 'team'       AND _operation IN ('create','write','delete') THEN false
      ELSE false
    END
  );

  IF _user_type = 'portal' THEN
    IF _module NOT IN ('leave','attendance') THEN
      RETURN false;
    END IF;
    _base_grants := false;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = _user_id
      AND mpg.organization_id = _org_id
      AND pgr.module = _module
      AND (
        (_operation = 'read'    AND pgr.can_read    = true) OR
        (_operation = 'create'  AND pgr.can_create  = true) OR
        (_operation = 'write'   AND pgr.can_write   = true) OR
        (_operation = 'delete'  AND pgr.can_delete  = true) OR
        (_operation = 'approve' AND pgr.can_approve = true) OR
        (_operation = 'post'    AND pgr.can_post    = true) OR
        (_operation = 'pay'     AND pgr.can_pay     = true) OR
        (_operation = 'close'   AND pgr.can_close   = true) OR
        (_operation = 'reverse' AND pgr.can_reverse = true) OR
        (_operation = 'export'  AND pgr.can_export  = true)
      )
  ) INTO _group_grants;

  RETURN _base_grants OR _group_grants;
END;
$function$;

REVOKE ALL ON FUNCTION public.user_has_module_permission(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_has_module_permission(uuid, uuid, text, text) TO authenticated, service_role;

-- 6) PIN lifecycle (server-authoritative) -------------------------------
CREATE OR REPLACE FUNCTION public.set_user_pin(p_pin text, p_device_fingerprint text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_pin_hash text;
  v_pin_length integer;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  v_pin_length := length(p_pin);

  IF v_pin_length < 4 OR v_pin_length > 6 THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN must be 4-6 digits');
  END IF;

  IF p_pin !~ '^\d+$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN must contain only digits');
  END IF;

  v_pin_hash := extensions.crypt(p_pin, extensions.gen_salt('bf'));

  INSERT INTO public.user_pins (user_id, pin_hash, pin_length, device_fingerprint, is_active, failed_attempts)
  VALUES (v_user_id, v_pin_hash, v_pin_length, p_device_fingerprint, true, 0)
  ON CONFLICT (user_id) DO UPDATE SET
    pin_hash = EXCLUDED.pin_hash,
    pin_length = EXCLUDED.pin_length,
    device_fingerprint = COALESCE(EXCLUDED.device_fingerprint, public.user_pins.device_fingerprint),
    is_active = true,
    failed_attempts = 0,
    locked_until = NULL,
    last_used_at = NULL,
    updated_at = now();

  INSERT INTO public.user_security_preferences (user_id, pin_enabled)
  VALUES (v_user_id, true)
  ON CONFLICT (user_id) DO UPDATE
    SET pin_enabled = true, updated_at = now();

  RETURN jsonb_build_object('success', true, 'message', 'PIN set successfully');
END;
$$;

REVOKE ALL ON FUNCTION public.set_user_pin(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_user_pin(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.verify_pin_unauthenticated(p_user_id uuid, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pin_hash text;
  v_failed_attempts integer;
  v_locked_until timestamptz;
  v_max_attempts integer := 5;
  v_lockout_minutes integer := 15;
BEGIN
  SELECT pin_hash, COALESCE(failed_attempts, 0), locked_until
    INTO v_pin_hash, v_failed_attempts, v_locked_until
    FROM public.user_pins
   WHERE user_id = p_user_id AND is_active = true;

  IF v_pin_hash IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No active PIN found');
  END IF;

  IF v_locked_until IS NOT NULL AND v_locked_until > now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN is temporarily locked',
      'locked', true, 'locked_until', v_locked_until, 'attempts_remaining', 0);
  END IF;

  IF extensions.crypt(p_pin, v_pin_hash) = v_pin_hash THEN
    UPDATE public.user_pins
       SET failed_attempts = 0, locked_until = NULL, last_used_at = now(), updated_at = now()
     WHERE user_id = p_user_id;
    RETURN jsonb_build_object('success', true);
  END IF;

  v_failed_attempts := v_failed_attempts + 1;

  IF v_failed_attempts >= v_max_attempts THEN
    v_locked_until := now() + make_interval(mins => v_lockout_minutes);
    UPDATE public.user_pins
       SET failed_attempts = v_failed_attempts, locked_until = v_locked_until, updated_at = now()
     WHERE user_id = p_user_id;
    RETURN jsonb_build_object('success', false, 'error', 'Too many failed attempts. PIN locked.',
      'locked', true, 'locked_until', v_locked_until, 'attempts_remaining', 0);
  END IF;

  UPDATE public.user_pins
     SET failed_attempts = v_failed_attempts, updated_at = now()
   WHERE user_id = p_user_id;

  RETURN jsonb_build_object('success', false, 'error', 'Invalid PIN',
    'locked', false, 'attempts_remaining', GREATEST(v_max_attempts - v_failed_attempts, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.verify_pin_unauthenticated(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_pin_unauthenticated(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.verify_user_pin(p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;
  RETURN public.verify_pin_unauthenticated(v_user_id, p_pin);
END;
$$;

REVOKE ALL ON FUNCTION public.verify_user_pin(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_user_pin(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.disable_user_pin()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  DELETE FROM public.user_pins WHERE user_id = v_user_id;

  INSERT INTO public.user_security_preferences (user_id, pin_enabled)
  VALUES (v_user_id, false)
  ON CONFLICT (user_id) DO UPDATE
    SET pin_enabled = false, updated_at = now();

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.disable_user_pin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.disable_user_pin() TO authenticated;

-- 7) Session payload -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_session_data(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  org_array     jsonb := '[]'::jsonb;
  org_row       record;
  role_row      record;
  group_rules   jsonb;
  user_count    int;
  v_logo_url    text;
  v_last_org_id uuid;
  is_admin      boolean := false;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('user_id', NULL, 'is_platform_admin', false,
      'organizations', '[]'::jsonb, 'last_org_id', NULL, 'fetched_at', now());
  END IF;

  BEGIN
    SELECT last_org_id INTO v_last_org_id
      FROM public.profiles WHERE user_id = p_user_id LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_last_org_id := NULL;
  END;

  FOR org_row IN
    SELECT o.id, o.name, o.slug
      FROM public.organizations o
      JOIN public.user_roles ur ON ur.organization_id = o.id
     WHERE ur.user_id = p_user_id AND ur.is_active = true
     ORDER BY o.created_at ASC
  LOOP
    BEGIN
      SELECT b.logo_url INTO v_logo_url
        FROM public.businesses b
       WHERE b.organization_id = org_row.id AND b.is_active = true AND b.logo_url IS NOT NULL
       ORDER BY b.created_at ASC LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      v_logo_url := NULL;
    END;

    SELECT ur.id AS role_id, ur.role, COALESCE(ur.user_type, 'internal') AS user_type
      INTO role_row
      FROM public.user_roles ur
     WHERE ur.user_id = p_user_id AND ur.organization_id = org_row.id AND ur.is_active = true
     LIMIT 1;

    SELECT COUNT(DISTINCT user_id) INTO user_count
      FROM public.user_roles
     WHERE organization_id = org_row.id AND is_active = true;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'module', pgr.module,
      'can_read', pgr.can_read,
      'can_create', pgr.can_create,
      'can_write', pgr.can_write,
      'can_delete', pgr.can_delete,
      'can_approve', pgr.can_approve,
      'can_post', pgr.can_post,
      'can_pay', pgr.can_pay,
      'can_close', pgr.can_close,
      'can_reverse', pgr.can_reverse,
      'can_export', pgr.can_export,
      'can_admin_override', pgr.can_admin_override
    )), '[]'::jsonb) INTO group_rules
      FROM public.member_permission_groups mpg
      JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
     WHERE mpg.user_id = p_user_id AND mpg.organization_id = org_row.id;

    org_array := org_array || jsonb_build_array(jsonb_build_object(
      'id', org_row.id,
      'name', org_row.name,
      'slug', org_row.slug,
      'logo_url', v_logo_url,
      'role', COALESCE(role_row.role::text, 'internal'),
      'role_id', role_row.role_id,
      'user_type', COALESCE(role_row.user_type, 'internal'),
      'plan', 'null'::jsonb,
      'app_entitlements', '[]'::jsonb,
      'entitlements', '[]'::jsonb,
      'feature_limits', '{}'::jsonb,
      'entitled_features', '[]'::jsonb,
      'overrides', '[]'::jsonb,
      'limit_overrides', '{}'::jsonb,
      'usage_counters', jsonb_build_object('users_count', user_count, 'storage_used_mb', 0),
      'permission_group_rules', group_rules
    ));
  END LOOP;

  IF v_last_org_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(org_array) AS e
        WHERE (e->>'id')::uuid = v_last_org_id
     ) THEN
    v_last_org_id := NULL;
  END IF;

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'is_platform_admin', is_admin,
    'organizations', org_array,
    'last_org_id', v_last_org_id,
    'fetched_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_user_session_data(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_session_data(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_last_org_id(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid() AND organization_id = p_org_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Not a member of that organization';
  END IF;

  UPDATE public.profiles SET last_org_id = p_org_id, updated_at = now()
   WHERE user_id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.set_last_org_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_last_org_id(uuid) TO authenticated;

-- 8) Bootstrap the development super administrator ----------------------
-- Idempotent: promotes the designated email to super_admin in every
-- organization it belongs to. Runs now (no-op if the user has not signed
-- up yet) and can be re-run after sign-up.
CREATE OR REPLACE FUNCTION public.bootstrap_super_admin(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_updated int := 0;
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1;
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No such user');
  END IF;

  UPDATE public.user_roles
     SET role = 'super_admin', is_active = true, updated_at = now()
   WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'user_id', v_user_id, 'roles_updated', v_updated);
END;
$$;

REVOKE ALL ON FUNCTION public.bootstrap_super_admin(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bootstrap_super_admin(text) TO service_role;

SELECT public.bootstrap_super_admin('fredrickmureti612@gmail.com');
