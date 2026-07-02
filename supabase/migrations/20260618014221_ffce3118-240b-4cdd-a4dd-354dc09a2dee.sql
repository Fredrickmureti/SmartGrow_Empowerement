-- Wave B3.1-fix — correctness for tg_mirror_attendance_device_to_assignment().
--
-- Why: the original trigger used `INSERT … ON CONFLICT DO NOTHING` with no
-- matching unique constraint, so every UPDATE of public.attendance_devices
-- inserted a brand-new mirror row in public.device_assignments, then the
-- follow-up UPDATE in the same trigger touched all duplicate rows. This
-- silently polluted the unified hardware registry and would have caused
-- claim_next_hardware_command to lock onto duplicates once B4.1 lands.
--
-- This migration:
--   1. Dedupes existing duplicates (keep MIN(id), soft-disable the rest).
--   2. Adds a UNIQUE partial index keyed on attendance_device_id in config.
--   3. Rewrites the trigger to use a single INSERT … ON CONFLICT DO UPDATE
--      against that index, eliminating the redundant follow-up UPDATE.

-- ─── Step 1: dedupe ───────────────────────────────────────────────────────
WITH ranked AS (
  SELECT id,
         organization_id,
         (config->>'attendance_device_id') AS adid,
         ROW_NUMBER() OVER (
           PARTITION BY organization_id, (config->>'attendance_device_id')
           ORDER BY created_at, id
         ) AS rn
    FROM public.device_assignments
   WHERE role = 'clock_terminal'
     AND (config->>'attendance_device_id') IS NOT NULL
)
UPDATE public.device_assignments da
   SET enabled    = false,
       status     = 'disconnected',
       last_error = COALESCE(
         NULLIF(da.last_error, ''),
         'Soft-disabled by B3.1-fix dedupe (' || to_char(now(), 'YYYY-MM-DD') || ')'
       ),
       updated_at = now()
  FROM ranked r
 WHERE da.id = r.id
   AND r.rn > 1;

-- ─── Step 2: unique partial index ────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS device_assignments_attendance_device_uniq
  ON public.device_assignments (organization_id, ((config->>'attendance_device_id')))
  WHERE role = 'clock_terminal'
    AND (config->>'attendance_device_id') IS NOT NULL;

-- ─── Step 3: rewrite the mirror trigger ──────────────────────────────────
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
  v_transport  text := 'network';
  v_driver     text;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    UPDATE public.device_assignments
       SET enabled    = false,
           status     = 'disconnected',
           updated_at = now()
     WHERE organization_id = OLD.organization_id
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
  ON CONFLICT (organization_id, ((config->>'attendance_device_id')))
    WHERE role = 'clock_terminal'
      AND (config->>'attendance_device_id') IS NOT NULL
  DO UPDATE
    SET enabled      = EXCLUDED.enabled,
        -- Preserve good runtime liveness when the device stays active;
        -- always flip to 'disconnected' when the device becomes disabled/
        -- suspended/revoked.
        status       = CASE
                         WHEN da.status IN ('connected','degraded')
                          AND EXCLUDED.enabled THEN da.status
                         ELSE EXCLUDED.status
                       END,
        display_name = EXCLUDED.display_name,
        driver       = EXCLUDED.driver,
        business_id  = EXCLUDED.business_id,
        config       = da.config || EXCLUDED.config,
        last_seen_at = COALESCE(EXCLUDED.last_seen_at, da.last_seen_at),
        updated_at   = now();

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.tg_mirror_attendance_device_to_assignment() IS
  'Wave B3.1-fix: idempotent one-way mirror from attendance_devices to device_assignments. Single INSERT … ON CONFLICT DO UPDATE against device_assignments_attendance_device_uniq guarantees exactly one mirror row per attendance device per organization.';
