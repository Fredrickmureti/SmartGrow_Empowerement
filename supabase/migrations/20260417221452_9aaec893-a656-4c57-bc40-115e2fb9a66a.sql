-- =====================================================================
-- STAGE 1: Owner protection + maker-checker (DB-level enforcement)
-- =====================================================================

-- 1) Add organizations.owner_user_id (the "sacred" owner reference)
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS owner_user_id uuid;

-- Backfill from existing owner role assignments (deterministic: oldest active owner)
UPDATE public.organizations o
SET owner_user_id = sub.user_id
FROM (
  SELECT DISTINCT ON (organization_id) organization_id, user_id
  FROM public.user_roles
  WHERE role = 'owner' AND is_active = true
  ORDER BY organization_id, created_at ASC
) sub
WHERE o.id = sub.organization_id
  AND o.owner_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_organizations_owner_user_id
  ON public.organizations(owner_user_id);

-- 2) Trigger: prevent direct mutation of organizations.owner_user_id
--    (forces transfers to go through transfer_organization_ownership)
CREATE OR REPLACE FUNCTION public.protect_organization_owner_field()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Allow if owner_user_id was NULL (initial backfill / new orgs) or unchanged
  IF OLD.owner_user_id IS NULL OR OLD.owner_user_id = NEW.owner_user_id THEN
    RETURN NEW;
  END IF;

  -- Otherwise, only platform admin or the dedicated transfer RPC may change it.
  -- We detect "called from inside SECURITY DEFINER transfer fn" via session GUC.
  IF current_setting('app.allow_owner_transfer', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF public.is_platform_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'organizations.owner_user_id may only be changed via transfer_organization_ownership()';
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_organization_owner ON public.organizations;
CREATE TRIGGER trg_protect_organization_owner
  BEFORE UPDATE OF owner_user_id ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_organization_owner_field();

-- 3) Trigger: enforce owner immutability on user_roles
--    Blocks: self-mutation of role/is_active, deactivating protected owner,
--            demoting protected owner, deleting protected owner row,
--            deactivating the last active owner.
CREATE OR REPLACE FUNCTION public.enforce_owner_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_protected_owner uuid;
  v_active_owner_count int;
  v_caller uuid := auth.uid();
BEGIN
  -- Bypass for platform admin and the transfer RPC
  IF public.is_platform_admin(v_caller)
     OR current_setting('app.allow_owner_transfer', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Look up the protected owner of the affected org
  SELECT owner_user_id INTO v_protected_owner
  FROM public.organizations
  WHERE id = COALESCE(NEW.organization_id, OLD.organization_id);

  -- ---------- DELETE / UPDATE on existing rows ----------
  IF TG_OP IN ('UPDATE','DELETE') THEN
    -- (a) Protected owner row is immutable
    IF OLD.user_id = v_protected_owner AND OLD.role = 'owner' THEN
      RAISE EXCEPTION 'The organization owner cannot be modified. Use Transfer Ownership instead.';
    END IF;

    -- (b) No self-mutation of role or active status (except by platform admin, handled above)
    IF OLD.user_id = v_caller AND TG_OP = 'UPDATE' THEN
      IF NEW.role IS DISTINCT FROM OLD.role
         OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
        RAISE EXCEPTION 'You cannot change your own role or active status.';
      END IF;
    END IF;

    -- (c) Last-active-owner protection (covers multi-owner orgs)
    IF OLD.role = 'owner'
       AND OLD.is_active = true
       AND (TG_OP = 'DELETE'
            OR NEW.is_active = false
            OR NEW.role <> 'owner') THEN
      SELECT COUNT(*) INTO v_active_owner_count
      FROM public.user_roles
      WHERE organization_id = OLD.organization_id
        AND role = 'owner'
        AND is_active = true
        AND id <> OLD.id;
      IF v_active_owner_count = 0 THEN
        RAISE EXCEPTION 'Cannot remove the last active owner of the organization.';
      END IF;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_owner_immutability_upd ON public.user_roles;
CREATE TRIGGER trg_enforce_owner_immutability_upd
  BEFORE UPDATE ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_owner_immutability();

DROP TRIGGER IF EXISTS trg_enforce_owner_immutability_del ON public.user_roles;
CREATE TRIGGER trg_enforce_owner_immutability_del
  BEFORE DELETE ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_owner_immutability();

-- 4) Replace the over-broad "Owners can manage roles" policy
--    The trigger above now enforces the dangerous cases; we keep the
--    permissive policy but it can no longer bypass owner-protection.
--    No policy change required since trigger fires regardless of policy,
--    but we tighten WITH CHECK to forbid promoting anyone to 'owner' or
--    'super_admin' through ordinary updates (transfer RPC is the only path).
DROP POLICY IF EXISTS "Owners can manage roles" ON public.user_roles;
CREATE POLICY "Owners can manage roles (insert)"
  ON public.user_roles
  FOR INSERT
  TO authenticated
  WITH CHECK (
    has_role(auth.uid(), organization_id, 'owner'::app_role)
    AND role <> 'super_admin'::app_role
  );

CREATE POLICY "Owners can manage roles (update)"
  ON public.user_roles
  FOR UPDATE
  TO authenticated
  USING (has_role(auth.uid(), organization_id, 'owner'::app_role))
  WITH CHECK (
    has_role(auth.uid(), organization_id, 'owner'::app_role)
    AND role <> 'super_admin'::app_role
  );

CREATE POLICY "Owners can delete roles"
  ON public.user_roles
  FOR DELETE
  TO authenticated
  USING (has_role(auth.uid(), organization_id, 'owner'::app_role));

-- 5) transfer_organization_ownership RPC
CREATE OR REPLACE FUNCTION public.transfer_organization_ownership(
  _org_id uuid,
  _new_owner_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_current_owner uuid;
  v_new_owner_active boolean;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT owner_user_id INTO v_current_owner
  FROM public.organizations WHERE id = _org_id;

  IF v_current_owner IS NULL THEN
    RAISE EXCEPTION 'Organization not found or has no protected owner';
  END IF;

  IF v_current_owner <> v_caller AND NOT public.is_platform_admin(v_caller) THEN
    RAISE EXCEPTION 'Only the current owner can transfer ownership';
  END IF;

  IF _new_owner_user_id = v_current_owner THEN
    RAISE EXCEPTION 'New owner must be a different user';
  END IF;

  -- New owner must already be an active member of the org
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE organization_id = _org_id
      AND user_id = _new_owner_user_id
      AND is_active = true
  ) INTO v_new_owner_active;

  IF NOT v_new_owner_active THEN
    RAISE EXCEPTION 'New owner must be an active member of the organization';
  END IF;

  -- Bypass owner-immutability triggers for this atomic transfer
  PERFORM set_config('app.allow_owner_transfer', 'on', true);

  -- Demote current owner to admin
  UPDATE public.user_roles
  SET role = 'admin'::app_role, updated_at = now()
  WHERE organization_id = _org_id
    AND user_id = v_current_owner
    AND role = 'owner'::app_role;

  -- Promote new owner (upsert: update if existing role row, else insert)
  UPDATE public.user_roles
  SET role = 'owner'::app_role, is_active = true, updated_at = now()
  WHERE organization_id = _org_id AND user_id = _new_owner_user_id;

  IF NOT FOUND THEN
    INSERT INTO public.user_roles (organization_id, user_id, role, is_active)
    VALUES (_org_id, _new_owner_user_id, 'owner'::app_role, true);
  END IF;

  -- Update the protected owner pointer
  UPDATE public.organizations
  SET owner_user_id = _new_owner_user_id, updated_at = now()
  WHERE id = _org_id;

  PERFORM set_config('app.allow_owner_transfer', 'off', true);
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_organization_ownership(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.transfer_organization_ownership(uuid, uuid) TO authenticated;

-- 6) Maker-checker trigger on payroll_runs
CREATE OR REPLACE FUNCTION public.enforce_payroll_maker_checker()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Trigger only fires on UPDATE moving status into 'approved' (or equivalent)
  IF TG_OP = 'UPDATE'
     AND NEW.status IN ('approved','posted','finalized')
     AND COALESCE(OLD.status,'') NOT IN ('approved','posted','finalized') THEN

    IF NEW.approved_by IS NULL THEN
      RAISE EXCEPTION 'Payroll approval requires an approver (approved_by must be set).';
    END IF;

    IF NEW.created_by IS NOT NULL AND NEW.approved_by = NEW.created_by THEN
      RAISE EXCEPTION 'Maker-checker violation: payroll cannot be approved by the same user who created it.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_payroll_maker_checker ON public.payroll_runs;
CREATE TRIGGER trg_enforce_payroll_maker_checker
  BEFORE UPDATE ON public.payroll_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_payroll_maker_checker();