-- Phase 3: capability-based device model
CREATE TABLE IF NOT EXISTS public.workstation_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workstation_id uuid NOT NULL REFERENCES public.workstations(id) ON DELETE CASCADE,
  device_key text NOT NULL,
  role text NOT NULL,
  transport text NOT NULL,
  driver text,
  name text,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  health text NOT NULL DEFAULT 'unknown',
  last_seen_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workstation_devices_uk
  ON public.workstation_devices (workstation_id, device_key);
CREATE INDEX IF NOT EXISTS workstation_devices_org_role_idx
  ON public.workstation_devices (organization_id, role);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.workstation_devices TO authenticated;
GRANT ALL ON public.workstation_devices TO service_role;
ALTER TABLE public.workstation_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wd_org_select" ON public.workstation_devices FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE POLICY "wd_org_manage" ON public.workstation_devices FOR ALL TO authenticated
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
  WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE TABLE IF NOT EXISTS public.workstation_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workstation_id uuid NOT NULL REFERENCES public.workstations(id) ON DELETE CASCADE,
  agent_version text,
  payload jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workstation_manifests_ws_idx
  ON public.workstation_manifests (workstation_id, published_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.workstation_manifests TO authenticated;
GRANT ALL ON public.workstation_manifests TO service_role;
ALTER TABLE public.workstation_manifests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wm_org_select" ON public.workstation_manifests FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE POLICY "wm_org_manage" ON public.workstation_manifests FOR ALL TO authenticated
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
  WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

-- updated_at triggers (reuse existing helper if present)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column' AND pronamespace = 'public'::regnamespace) THEN
    CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS TRIGGER
    LANGUAGE plpgsql SET search_path = public AS $body$
    BEGIN NEW.updated_at = now(); RETURN NEW; END; $body$;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_wd_touch ON public.workstation_devices;
CREATE TRIGGER trg_wd_touch BEFORE UPDATE ON public.workstation_devices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_wm_touch ON public.workstation_manifests;
CREATE TRIGGER trg_wm_touch BEFORE UPDATE ON public.workstation_manifests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Realtime
ALTER TABLE public.workstation_devices REPLICA IDENTITY FULL;
ALTER TABLE public.workstation_manifests REPLICA IDENTITY FULL;
DO $$ BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.workstation_devices;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.workstation_manifests;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;