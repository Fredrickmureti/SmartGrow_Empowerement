-- Phase A: Purge the broken legacy mirror trigger and the orphaned
-- pos_hardware_configs table. Wave 9b targeted older trigger/function
-- names and missed the rename to device_assignment_legacy_mirror /
-- device_assignment_to_legacy_mirror, leaving a trigger that references
-- pos_hardware_configs.source_assignment_id (a column the live table
-- never had). Every INSERT into device_assignments raises 42703.

-- 1. Drop every known variant of the mirror trigger + function.
DROP TRIGGER  IF EXISTS device_assignment_legacy_mirror ON public.device_assignments;
DROP FUNCTION IF EXISTS public.device_assignment_to_legacy_mirror() CASCADE;
DROP TRIGGER  IF EXISTS pos_hw_config_mirror ON public.device_assignments;
DROP FUNCTION IF EXISTS public.pos_hw_config_mirror() CASCADE;
DROP FUNCTION IF EXISTS public.mirror_device_assignment_to_pos_hardware_configs() CASCADE;

-- 2. Guarded drop of the legacy table. Abort if any legacy row is not
--    already represented in the canonical device_assignments table.
DO $$
DECLARE
  unmirrored int;
BEGIN
  IF to_regclass('public.pos_hardware_configs') IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO unmirrored
  FROM public.pos_hardware_configs c
  WHERE NOT EXISTS (
    SELECT 1 FROM public.device_assignments d
    WHERE d.organization_id = c.organization_id
      AND d.role      = c.device_role
      AND d.transport = c.connection_type
      AND d.driver    = c.driver_type
  );

  IF unmirrored > 0 THEN
    RAISE EXCEPTION
      'Phase-A abort: % pos_hardware_configs rows not represented in device_assignments — migrate before re-running.',
      unmirrored;
  END IF;
END $$;

DROP TABLE IF EXISTS public.pos_hardware_configs CASCADE;