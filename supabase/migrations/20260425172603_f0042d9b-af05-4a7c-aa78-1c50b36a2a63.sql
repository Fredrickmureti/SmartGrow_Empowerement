
ALTER TABLE public.platform_apps
  ADD COLUMN IF NOT EXISTS is_free boolean NOT NULL DEFAULT false;

UPDATE public.platform_apps
   SET is_free = true
 WHERE id IN ('employees','contacts','finance','reports','platform');

CREATE TABLE IF NOT EXISTS public.app_regions (
  app_id text NOT NULL REFERENCES public.platform_apps(id) ON DELETE CASCADE,
  country_code text NOT NULL,
  is_available boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, country_code)
);
ALTER TABLE public.app_regions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "app_regions readable by all authenticated" ON public.app_regions;
CREATE POLICY "app_regions readable by all authenticated"
  ON public.app_regions FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "app_regions managed by platform admins" ON public.app_regions;
CREATE POLICY "app_regions managed by platform admins"
  ON public.app_regions FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

DO $$ BEGIN
  CREATE TYPE public.app_lifecycle_state AS ENUM (
    'active','trial','trial_expired','suspended','uninstalled_readonly','archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.organization_installed_apps
  ADD COLUMN IF NOT EXISTS lifecycle_state public.app_lifecycle_state NOT NULL DEFAULT 'active';

UPDATE public.organization_installed_apps
   SET lifecycle_state = 'uninstalled_readonly'
 WHERE is_active = false AND lifecycle_state = 'active';

INSERT INTO public.app_dependencies (app_id, depends_on_app_id, dependency_type, auto_install, billing_behavior)
VALUES
  ('time-off',    'employees', 'required', true,  'free_foundation'),
  ('attendance',  'employees', 'required', true,  'free_foundation'),
  ('timesheets',  'employees', 'required', true,  'free_foundation'),
  ('payroll',     'employees', 'required', true,  'free_foundation'),
  ('recruitment', 'employees', 'required', true,  'free_foundation'),
  ('payroll',     'finance',   'required', true,  'free_foundation'),
  ('payroll',     'time-off',    'optional', false, 'separate'),
  ('payroll',     'attendance',  'optional', false, 'separate'),
  ('payroll',     'timesheets',  'optional', false, 'separate'),
  ('timesheets',  'projects',  'optional', false, 'separate')
ON CONFLICT (app_id, depends_on_app_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.has_app_entitlement(_org_id uuid, _app_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_installed_apps oia
     WHERE oia.organization_id = _org_id AND oia.app_id = _app_id
       AND oia.lifecycle_state IN ('active','trial')
  )
  OR EXISTS (SELECT 1 FROM public.platform_apps pa WHERE pa.id = _app_id AND pa.is_free = true);
$$;

CREATE OR REPLACE FUNCTION public.user_has_app_access(_user_id uuid, _org_id uuid, _app_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_app_entitlement(_org_id, _app_id)
    AND (
      public.is_platform_admin(_user_id)
      OR EXISTS (
        SELECT 1 FROM public.member_permission_groups mpg
          JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
         WHERE mpg.user_id = _user_id AND mpg.organization_id = _org_id
           AND pgr.module = _app_id AND pgr.can_read = true
      )
      OR EXISTS (
        SELECT 1 FROM public.user_business_access uba
         WHERE uba.user_id = _user_id
           AND uba.business_id IN (SELECT id FROM public.businesses WHERE organization_id = _org_id)
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.validate_payroll_run_entitlement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_app_entitlement(NEW.organization_id, 'payroll') THEN
    RAISE EXCEPTION 'Organization does not have an active Payroll entitlement';
  END IF;
  IF NOT public.has_app_entitlement(NEW.organization_id, 'finance') THEN
    RAISE EXCEPTION 'Payroll requires the Finance app to be installed (for GL posting)';
  END IF;
  IF NOT public.has_app_entitlement(NEW.organization_id, 'employees') THEN
    RAISE EXCEPTION 'Payroll requires the Employees app';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_validate_payroll_run_entitlement ON public.payroll_runs;
CREATE TRIGGER trg_validate_payroll_run_entitlement
  BEFORE INSERT ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.validate_payroll_run_entitlement();

CREATE OR REPLACE FUNCTION public.seed_system_permission_groups(_org_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  group_names text[] := ARRAY[
    'tenant_owner','accountant','hr_manager','payroll_officer',
    'branch_manager','salesperson','pos_cashier','employee_self_service'
  ];
  g text;
BEGIN
  FOREACH g IN ARRAY group_names LOOP
    INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
    VALUES (_org_id, g, 'System group: ' || g, true, true)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT id FROM public.organizations LOOP
    PERFORM public.seed_system_permission_groups(r.id);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.trg_seed_permission_groups_on_org()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN PERFORM public.seed_system_permission_groups(NEW.id); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_org_seed_permission_groups ON public.organizations;
CREATE TRIGGER trg_org_seed_permission_groups
  AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.trg_seed_permission_groups_on_org();

DROP TRIGGER IF EXISTS trg_app_regions_updated_at ON public.app_regions;
CREATE TRIGGER trg_app_regions_updated_at
  BEFORE UPDATE ON public.app_regions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
