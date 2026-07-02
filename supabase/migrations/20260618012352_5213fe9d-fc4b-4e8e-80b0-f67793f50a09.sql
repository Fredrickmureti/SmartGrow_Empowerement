-- Wave B3.1 — mirror public.attendance_devices into public.device_assignments
-- so the unified hardware registry sees clock/biometric terminals alongside
-- POS peripherals. Mirror is one-way (attendance_devices → device_assignments);
-- attendance_devices remains the source of truth for HMAC secrets and biometric
-- metadata that have no place in the generic registry.

CREATE OR REPLACE FUNCTION public.tg_mirror_attendance_device_to_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role       text := 'clock_terminal';
  v_enabled    boolean;
  v_status     text;
  v_display    text;
  v_transport  text := 'network'; -- biometric vendors are LAN-attached
  v_driver     text;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    -- Hard delete on attendance_devices → soft-disable the mirror row so
    -- audit trails on commands/health keep their FK chain.
    UPDATE public.device_assignments
       SET enabled = false,
           status  = 'disconnected',
           updated_at = now()
     WHERE organization_id = OLD.organization_id
       AND scope_kind = 'tenant'
       AND role = 'clock_terminal'
       AND (config->>'attendance_device_id') = OLD.id::text;
    RETURN OLD;
  END IF;

  v_enabled := (NEW.status = 'active');
  v_status  := CASE WHEN NEW.status = 'active' THEN 'unknown'
                    ELSE 'disconnected' END;
  v_display := COALESCE(NULLIF(NEW.metadata->>'name',''),
                        NEW.vendor || ' ' || NEW.serial);
  v_driver  := NEW.vendor;

  INSERT INTO public.device_assignments AS da
    (organization_id, business_id, scope_kind, scope_id, role, transport, driver,
     display_name, config, enabled, status, last_seen_at)
  VALUES
    (NEW.organization_id, NEW.business_id, 'tenant', NULL, v_role, v_transport, v_driver,
     v_display,
     jsonb_build_object(
       'attendance_device_id', NEW.id,
       'public_id', NEW.public_id,
       'serial', NEW.serial,
       'vendor', NEW.vendor,
       'branch_id', NEW.branch_id
     ),
     v_enabled, v_status, NEW.last_seen_at)
  ON CONFLICT DO NOTHING;

  -- Match by attendance_device_id in config (no schema-level unique key for this).
  UPDATE public.device_assignments
     SET enabled      = v_enabled,
         status       = CASE
                          WHEN status IN ('connected','degraded') AND v_enabled THEN status
                          ELSE v_status
                        END,
         display_name = v_display,
         driver       = v_driver,
         business_id  = NEW.business_id,
         config       = config
                        || jsonb_build_object(
                             'public_id', NEW.public_id,
                             'serial', NEW.serial,
                             'vendor', NEW.vendor,
                             'branch_id', NEW.branch_id
                           ),
         last_seen_at = COALESCE(NEW.last_seen_at, last_seen_at),
         updated_at   = now()
   WHERE organization_id = NEW.organization_id
     AND scope_kind = 'tenant'
     AND role = 'clock_terminal'
     AND (config->>'attendance_device_id') = NEW.id::text;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_mirror_attendance_device_to_assignment
  ON public.attendance_devices;

CREATE TRIGGER trg_mirror_attendance_device_to_assignment
  AFTER INSERT OR UPDATE OR DELETE ON public.attendance_devices
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_mirror_attendance_device_to_assignment();

-- Backfill: existing attendance_devices → device_assignments. Idempotent via
-- the NOT EXISTS guard so reruns are safe.
INSERT INTO public.device_assignments
  (organization_id, business_id, scope_kind, scope_id, role, transport, driver,
   display_name, config, enabled, status, last_seen_at)
SELECT
  ad.organization_id,
  ad.business_id,
  'tenant', NULL,
  'clock_terminal',
  'network',
  ad.vendor,
  COALESCE(NULLIF(ad.metadata->>'name',''), ad.vendor || ' ' || ad.serial),
  jsonb_build_object(
    'attendance_device_id', ad.id,
    'public_id', ad.public_id,
    'serial', ad.serial,
    'vendor', ad.vendor,
    'branch_id', ad.branch_id
  ),
  (ad.status = 'active'),
  CASE WHEN ad.status = 'active' THEN 'unknown' ELSE 'disconnected' END,
  ad.last_seen_at
FROM public.attendance_devices ad
WHERE NOT EXISTS (
  SELECT 1 FROM public.device_assignments da
   WHERE da.organization_id = ad.organization_id
     AND da.scope_kind = 'tenant'
     AND da.role = 'clock_terminal'
     AND (da.config->>'attendance_device_id') = ad.id::text
);

COMMENT ON FUNCTION public.tg_mirror_attendance_device_to_assignment() IS
  'Wave B3.1: keeps device_assignments in sync with attendance_devices so the unified hardware registry sees clock/biometric terminals. One-way mirror; attendance_devices keeps HMAC + biometric metadata.';
