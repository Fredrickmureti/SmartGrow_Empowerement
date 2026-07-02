-- ============================================================
-- Persona exclusivity (DB-enforced) + invitation validation
-- ============================================================
-- Builds on ADR-0004. Replaces the previous "claimed but missing"
-- triggers/RPCs referenced by PersonaConflictsCard.
-- Hard block: a user is EITHER platform_admin OR tenant member, never both.
-- ============================================================

-- ---------- Helper SECURITY DEFINER predicates ----------

CREATE OR REPLACE FUNCTION public._user_is_active_platform_admin(p_user UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_admins
    WHERE user_id = p_user AND is_active = true
  );
$$;

CREATE OR REPLACE FUNCTION public._user_has_active_tenant_role(p_user UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_user AND is_active = true
  );
$$;

REVOKE ALL ON FUNCTION public._user_is_active_platform_admin(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._user_has_active_tenant_role(UUID) FROM PUBLIC, anon;

-- ---------- Trigger: block adding tenant role for existing platform admin ----------

CREATE OR REPLACE FUNCTION public.enforce_persona_exclusivity_user_roles()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only enforce when the row is being made (or staying) active.
  IF COALESCE(NEW.is_active, true) IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- Skip when nothing relevant changed (UPDATE that toggles unrelated fields).
  IF TG_OP = 'UPDATE'
     AND OLD.user_id = NEW.user_id
     AND COALESCE(OLD.is_active, false) = COALESCE(NEW.is_active, false) THEN
    RETURN NEW;
  END IF;

  IF public._user_is_active_platform_admin(NEW.user_id) THEN
    RAISE EXCEPTION
      'Persona conflict: user % is an active platform admin and cannot also be a tenant workspace member. Use a separate email address for tenant accounts.',
      NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_persona_exclusivity_user_roles
  ON public.user_roles;

CREATE TRIGGER trg_enforce_persona_exclusivity_user_roles
  BEFORE INSERT OR UPDATE ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_persona_exclusivity_user_roles();

-- ---------- Trigger: block adding platform admin for existing tenant member ----------

CREATE OR REPLACE FUNCTION public.enforce_persona_exclusivity_platform_admins()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.is_active, true) IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- Allow the dummy placeholder user used by the legacy invitation flow.
  IF NEW.user_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.user_id = NEW.user_id
     AND COALESCE(OLD.is_active, false) = COALESCE(NEW.is_active, false) THEN
    RETURN NEW;
  END IF;

  IF public._user_has_active_tenant_role(NEW.user_id) THEN
    RAISE EXCEPTION
      'Persona conflict: user % is an active tenant workspace member and cannot also be a platform admin. Use a separate email address for the platform admin account.',
      NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_persona_exclusivity_platform_admins
  ON public.platform_admins;

CREATE TRIGGER trg_enforce_persona_exclusivity_platform_admins
  BEFORE INSERT OR UPDATE ON public.platform_admins
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_persona_exclusivity_platform_admins();

-- ---------- RPC: list_persona_conflicts() ----------
-- Owner-only listing of legacy persona conflicts (rows that pre-date the
-- triggers above). Shape matches PersonaConflictsCard's expected interface.

CREATE OR REPLACE FUNCTION public.list_persona_conflicts()
RETURNS TABLE(
  user_id UUID,
  email TEXT,
  active_platform_admin BOOLEAN,
  active_tenant_roles INTEGER,
  organization_ids UUID[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Owner-only. We don't have a public.is_platform_owner() helper, so check inline.
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admins
    WHERE user_id = auth.uid()
      AND is_active = true
      AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only the platform owner may list persona conflicts'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT
    pa.user_id,
    COALESCE(p.email, '(unknown)')             AS email,
    true                                       AS active_platform_admin,
    COUNT(ur.id)::INTEGER                      AS active_tenant_roles,
    COALESCE(array_agg(DISTINCT ur.organization_id) FILTER (WHERE ur.organization_id IS NOT NULL), '{}'::uuid[])
                                               AS organization_ids
  FROM public.platform_admins pa
  JOIN public.user_roles ur
    ON ur.user_id = pa.user_id AND ur.is_active = true
  LEFT JOIN public.profiles p
    ON p.user_id = pa.user_id
  WHERE pa.is_active = true
    AND pa.user_id <> '00000000-0000-0000-0000-000000000000'::uuid
  GROUP BY pa.user_id, p.email;
END;
$$;

REVOKE ALL ON FUNCTION public.list_persona_conflicts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_persona_conflicts() TO authenticated;

-- ---------- RPC: validate_platform_invitation(token) ----------
-- Public-callable lookup for the Accept Invitation page so the invitee can
-- see what they're accepting before signing up. Returns minimal details only;
-- never leaks the invited_by user id or notes.

CREATE OR REPLACE FUNCTION public.validate_platform_invitation(_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row RECORD;
BEGIN
  IF _token IS NULL OR length(_token) < 16 THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'invalid_token');
  END IF;

  SELECT id, email, role, status, expires_at
    INTO _row
  FROM public.platform_admin_invitations
  WHERE token = _token
  LIMIT 1;

  IF _row.id IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'not_found');
  END IF;

  IF _row.status <> 'pending' THEN
    RETURN jsonb_build_object('valid', false, 'reason', _row.status);
  END IF;

  IF _row.expires_at < now() THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'expired');
  END IF;

  RETURN jsonb_build_object(
    'valid', true,
    'email', _row.email,
    'role',  _row.role,
    'expires_at', _row.expires_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.validate_platform_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_platform_invitation(TEXT) TO anon, authenticated;

-- ---------- ADR-0004 doc note marker (idempotent comment) ----------
COMMENT ON FUNCTION public.enforce_persona_exclusivity_user_roles() IS
  'ADR-0004: hard block — a user is EITHER platform_admin OR tenant member.';
COMMENT ON FUNCTION public.enforce_persona_exclusivity_platform_admins() IS
  'ADR-0004: hard block — a user is EITHER platform_admin OR tenant member.';
COMMENT ON FUNCTION public.list_persona_conflicts() IS
  'Owner-only: lists legacy persona conflicts (pre-trigger rows). Used by PersonaConflictsCard.';
COMMENT ON FUNCTION public.validate_platform_invitation(TEXT) IS
  'Public token lookup for the Accept Invitation page (no PII beyond email + role).';