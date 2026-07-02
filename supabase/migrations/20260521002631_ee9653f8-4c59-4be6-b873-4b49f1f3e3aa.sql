-- Phase 5: Defensive DB invariants for core app install state
-- Prevents the symptom class "already-installed core app appears uninstalled"
-- from re-occurring server-side.

CREATE OR REPLACE FUNCTION public.enforce_core_app_active_tg()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_core BOOLEAN;
  v_app_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_app_id := OLD.app_id;
  ELSE
    v_app_id := NEW.app_id;
  END IF;

  SELECT is_core INTO v_is_core
  FROM public.platform_apps
  WHERE id = v_app_id;

  IF v_is_core IS NOT TRUE THEN
    -- Not a core app: no enforcement.
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CORE_APP_PROTECTED: cannot delete core app % from organization %', OLD.app_id, OLD.organization_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.is_active = false AND OLD.is_active = true THEN
    RAISE EXCEPTION 'CORE_APP_PROTECTED: cannot deactivate core app % for organization %', NEW.app_id, NEW.organization_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_core_app_active ON public.organization_installed_apps;

CREATE TRIGGER trg_enforce_core_app_active
BEFORE UPDATE OR DELETE ON public.organization_installed_apps
FOR EACH ROW
EXECUTE FUNCTION public.enforce_core_app_active_tg();

-- Idempotent backfill: re-activate any core-app rows that were previously
-- flipped to inactive (these would be victims of the symptom class above).
UPDATE public.organization_installed_apps oia
SET is_active = true
FROM public.platform_apps pa
WHERE oia.app_id = pa.id
  AND pa.is_core = true
  AND oia.is_active = false;