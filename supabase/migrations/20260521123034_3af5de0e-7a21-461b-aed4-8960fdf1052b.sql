-- Wave 9b — drop the legacy pos_hardware_configs mirror.
-- The canonical registry is device_assignments; all renderer code and
-- the diagnostics page have been migrated. Fail-fast if any row exists
-- in the legacy table that is not represented in device_assignments
-- (by the (role/device_role, transport/connection_type, driver/driver_type)
-- shape) for the same organization.

DO $$
DECLARE
  unmirrored INT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'pos_hardware_configs'
  ) THEN
    SELECT COUNT(*) INTO unmirrored
    FROM public.pos_hardware_configs c
    WHERE NOT EXISTS (
      SELECT 1 FROM public.device_assignments d
      WHERE d.organization_id = c.organization_id
        AND d.role       = c.device_role
        AND d.transport  = c.connection_type
        AND d.driver     = c.driver_type
    );
    IF unmirrored > 0 THEN
      RAISE EXCEPTION 'Wave 9b abort: % pos_hardware_configs rows not present in device_assignments — investigate before re-running.', unmirrored;
    END IF;
  END IF;
END $$;

-- Drop the reverse-mirror trigger + function if present.
DROP TRIGGER  IF EXISTS pos_hw_config_mirror ON public.device_assignments;
DROP FUNCTION IF EXISTS public.pos_hw_config_mirror() CASCADE;
DROP FUNCTION IF EXISTS public.mirror_device_assignment_to_pos_hardware_configs() CASCADE;

-- Drop the table itself (CASCADE removes the FK on device_assignments.source_assignment_id
-- and any leftover RLS policies/indexes).
DROP TABLE IF EXISTS public.pos_hardware_configs CASCADE;