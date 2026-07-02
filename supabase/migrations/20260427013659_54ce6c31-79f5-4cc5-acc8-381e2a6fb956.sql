-- ============================================================
-- Patch: assert_app_installed_for_write
-- Add two bypass conditions:
--   1. Tenant reset/delete in progress (app.reset_in_progress GUC)
--   2. Caller is a platform admin (lifecycle operations)
-- This mirrors the bypass pattern used by the FK-protector triggers
-- in migrations 20260418180131 and 20260424081127.
-- ============================================================

CREATE OR REPLACE FUNCTION public.assert_app_installed_for_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _app_id text := TG_ARGV[0];
  _org_id uuid;
  _installed boolean;
  _reset_org text;
  _caller uuid;
BEGIN
  -- Resolve the org id from NEW (INSERT/UPDATE) or OLD (DELETE).
  IF TG_OP = 'DELETE' THEN
    _org_id := OLD.organization_id;
  ELSE
    _org_id := NEW.organization_id;
  END IF;

  IF _org_id IS NULL THEN
    -- Defensive: never block writes that lack an org_id (legacy rows).
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Bypass 1: tenant reset / platform delete in progress for this org.
  -- This GUC is set by reset_organization_data() and platform_delete_organization()
  -- via set_config('app.reset_in_progress', org_id::text, true).
  _reset_org := current_setting('app.reset_in_progress', true);
  IF _reset_org IS NOT NULL AND _reset_org = _org_id::text THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Bypass 2: platform admin lifecycle operations (suspend/purge/migrate).
  -- Module-installed gating is a tenant-side guarantee, not a platform-side one.
  _caller := auth.uid();
  IF _caller IS NOT NULL AND public.is_platform_admin(_caller) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.organization_installed_apps oia
    WHERE oia.organization_id = _org_id
      AND oia.app_id = _app_id
      AND oia.is_active = true
  ) INTO _installed;

  IF NOT _installed THEN
    RAISE EXCEPTION 'APP_NOT_INSTALLED: % is not installed for this organization. Reinstall the app to make changes; existing records remain readable.', _app_id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.assert_app_installed_for_write() IS
  'Trigger function: blocks INSERT/UPDATE/DELETE on tables belonging to an uninstalled app. Bypasses for (a) tenant resets/deletes via app.reset_in_progress GUC, and (b) platform admin callers. Read access remains via RLS.';
