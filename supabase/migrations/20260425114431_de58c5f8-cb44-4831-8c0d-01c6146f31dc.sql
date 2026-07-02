-- HR Domain Split — Odoo-aligned app split.

-- 1) Seed plan_app_access for the 5 new apps from the legacy `hr` row ---------
WITH legacy AS (
  SELECT plan_id, is_enabled FROM plan_app_access WHERE app_id = 'hr'
),
new_apps(app_id) AS (
  VALUES ('employees'), ('time-off'), ('attendance'), ('payroll'), ('recruitment')
)
INSERT INTO plan_app_access (plan_id, app_id, is_enabled)
SELECT
  l.plan_id,
  na.app_id,
  CASE WHEN na.app_id = 'recruitment' THEN false ELSE l.is_enabled END
FROM legacy l
CROSS JOIN new_apps na
ON CONFLICT DO NOTHING;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_app_access_plan_app_unique')
     AND NOT EXISTS (SELECT plan_id, app_id FROM plan_app_access GROUP BY plan_id, app_id HAVING COUNT(*) > 1)
  THEN
    ALTER TABLE plan_app_access ADD CONSTRAINT plan_app_access_plan_app_unique UNIQUE (plan_id, app_id);
  END IF;
END $$;

-- 2) Backfill organization_installed_apps from any existing `hr` installation -
INSERT INTO organization_installed_apps (organization_id, app_id, installed_by, is_active, settings, onboarding_status)
SELECT
  o.organization_id, na.app_id, o.installed_by, o.is_active, o.settings, o.onboarding_status
FROM organization_installed_apps o
CROSS JOIN (VALUES ('employees'), ('time-off'), ('attendance'), ('payroll')) AS na(app_id)
WHERE o.app_id = 'hr'
  AND NOT EXISTS (
    SELECT 1 FROM organization_installed_apps x
    WHERE x.organization_id = o.organization_id AND x.app_id = na.app_id
  );

-- 3) App dependency graph -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_dependencies (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  app_id TEXT NOT NULL,
  depends_on_app_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (app_id, depends_on_app_id),
  CHECK (app_id <> depends_on_app_id)
);

ALTER TABLE public.app_dependencies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "App dependencies readable by authenticated" ON public.app_dependencies;
CREATE POLICY "App dependencies readable by authenticated"
  ON public.app_dependencies FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Only platform admins can modify app dependencies" ON public.app_dependencies;
CREATE POLICY "Only platform admins can modify app dependencies"
  ON public.app_dependencies FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

INSERT INTO public.app_dependencies (app_id, depends_on_app_id) VALUES
  ('time-off',    'employees'),
  ('attendance',  'employees'),
  ('payroll',     'employees'),
  ('recruitment', 'employees')
ON CONFLICT (app_id, depends_on_app_id) DO NOTHING;

-- 4) Trigger: auto-install dependencies when a dependent is installed ---------
CREATE OR REPLACE FUNCTION public.ensure_app_dependencies_installed()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE dep TEXT;
BEGIN
  FOR dep IN SELECT depends_on_app_id FROM public.app_dependencies WHERE app_id = NEW.app_id LOOP
    INSERT INTO public.organization_installed_apps (organization_id, app_id, installed_by, is_active)
    VALUES (NEW.organization_id, dep, NEW.installed_by, true)
    ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ensure_app_dependencies ON public.organization_installed_apps;
CREATE TRIGGER trg_ensure_app_dependencies
AFTER INSERT ON public.organization_installed_apps
FOR EACH ROW
EXECUTE FUNCTION public.ensure_app_dependencies_installed();

-- 5) Trigger: block uninstall of an app that has active dependents ------------
CREATE OR REPLACE FUNCTION public.block_app_uninstall_if_dependents_active()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE active_dependent TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT app_id INTO active_dependent
    FROM public.organization_installed_apps
    WHERE organization_id = OLD.organization_id
      AND is_active = true
      AND app_id IN (SELECT app_id FROM public.app_dependencies WHERE depends_on_app_id = OLD.app_id)
    LIMIT 1;
    IF active_dependent IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot uninstall %: app % depends on it. Uninstall % first.',
        OLD.app_id, active_dependent, active_dependent;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.is_active = false AND OLD.is_active = true THEN
    SELECT app_id INTO active_dependent
    FROM public.organization_installed_apps
    WHERE organization_id = NEW.organization_id
      AND is_active = true
      AND app_id IN (SELECT app_id FROM public.app_dependencies WHERE depends_on_app_id = NEW.app_id)
    LIMIT 1;
    IF active_dependent IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot disable %: app % depends on it. Disable % first.',
        NEW.app_id, active_dependent, active_dependent;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_app_uninstall_if_dependents_active ON public.organization_installed_apps;
CREATE TRIGGER trg_block_app_uninstall_if_dependents_active
BEFORE DELETE OR UPDATE ON public.organization_installed_apps
FOR EACH ROW
EXECUTE FUNCTION public.block_app_uninstall_if_dependents_active();

CREATE INDEX IF NOT EXISTS idx_app_dependencies_app ON public.app_dependencies(app_id);
CREATE INDEX IF NOT EXISTS idx_app_dependencies_depends_on ON public.app_dependencies(depends_on_app_id);