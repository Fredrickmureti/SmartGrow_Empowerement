
CREATE TABLE IF NOT EXISTS public.device_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  scope_kind text NOT NULL CHECK (scope_kind IN ('register','station','user','tenant')),
  scope_id uuid,
  role text NOT NULL,
  transport text NOT NULL,
  driver text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'unknown',
  last_seen_at timestamptz,
  last_error text,
  source_config_id uuid UNIQUE REFERENCES public.pos_hardware_configs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS device_assignments_org_role_idx
  ON public.device_assignments(organization_id, role) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS device_assignments_scope_idx
  ON public.device_assignments(organization_id, scope_kind, scope_id);

ALTER TABLE public.device_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "device_assignments_select_org_members"
  ON public.device_assignments FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

CREATE POLICY "device_assignments_insert_org_members"
  ON public.device_assignments FOR INSERT
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

CREATE POLICY "device_assignments_update_org_members"
  ON public.device_assignments FOR UPDATE
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

CREATE POLICY "device_assignments_delete_org_members"
  ON public.device_assignments FOR DELETE
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

CREATE OR REPLACE FUNCTION public.touch_device_assignments_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS device_assignments_set_updated_at ON public.device_assignments;
CREATE TRIGGER device_assignments_set_updated_at
  BEFORE UPDATE ON public.device_assignments
  FOR EACH ROW EXECUTE FUNCTION public.touch_device_assignments_updated_at();

CREATE OR REPLACE FUNCTION public.mirror_pos_hw_config_to_device_assignments()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_scope_kind text; v_scope_id uuid;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM public.device_assignments WHERE source_config_id = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.register_id IS NOT NULL THEN
    v_scope_kind := 'register'; v_scope_id := NEW.register_id;
  ELSE
    v_scope_kind := 'tenant'; v_scope_id := NULL;
  END IF;

  INSERT INTO public.device_assignments (
    organization_id, business_id, scope_kind, scope_id,
    role, transport, driver, display_name,
    config, capabilities, enabled, is_default,
    status, last_seen_at, last_error, source_config_id
  ) VALUES (
    NEW.organization_id, NEW.business_id, v_scope_kind, v_scope_id,
    COALESCE(NEW.device_role, NEW.hardware_type),
    NEW.connection_type,
    COALESCE(NEW.driver_type, 'generic'),
    NEW.display_name,
    COALESCE(NEW.connection_params, '{}'::jsonb),
    COALESCE(NEW.capabilities, '{}'::jsonb),
    COALESCE(NEW.is_active, true),
    COALESCE(NEW.is_default, false),
    NEW.status, NEW.last_seen_at, NEW.last_error, NEW.id
  )
  ON CONFLICT (source_config_id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    business_id     = EXCLUDED.business_id,
    scope_kind      = EXCLUDED.scope_kind,
    scope_id        = EXCLUDED.scope_id,
    role            = EXCLUDED.role,
    transport       = EXCLUDED.transport,
    driver          = EXCLUDED.driver,
    display_name    = EXCLUDED.display_name,
    config          = EXCLUDED.config,
    capabilities    = EXCLUDED.capabilities,
    enabled         = EXCLUDED.enabled,
    is_default      = EXCLUDED.is_default,
    status          = EXCLUDED.status,
    last_seen_at    = EXCLUDED.last_seen_at,
    last_error      = EXCLUDED.last_error;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pos_hw_config_mirror ON public.pos_hardware_configs;
CREATE TRIGGER pos_hw_config_mirror
  AFTER INSERT OR UPDATE OR DELETE ON public.pos_hardware_configs
  FOR EACH ROW EXECUTE FUNCTION public.mirror_pos_hw_config_to_device_assignments();

INSERT INTO public.device_assignments (
  organization_id, business_id, scope_kind, scope_id,
  role, transport, driver, display_name,
  config, capabilities, enabled, is_default,
  status, last_seen_at, last_error, source_config_id
)
SELECT
  c.organization_id, c.business_id,
  CASE WHEN c.register_id IS NOT NULL THEN 'register' ELSE 'tenant' END,
  c.register_id,
  COALESCE(c.device_role, c.hardware_type),
  c.connection_type,
  COALESCE(c.driver_type, 'generic'),
  c.display_name,
  COALESCE(c.connection_params, '{}'::jsonb),
  COALESCE(c.capabilities, '{}'::jsonb),
  COALESCE(c.is_active, true),
  COALESCE(c.is_default, false),
  c.status, c.last_seen_at, c.last_error, c.id
FROM public.pos_hardware_configs c
ON CONFLICT (source_config_id) DO NOTHING;
