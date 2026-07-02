-- Drop hardcoded CHECK constraints on pos_hardware_configs
-- These prevent adding new driver types without a migration
-- Application-level validation via DriverRegistry replaces them
ALTER TABLE public.pos_hardware_configs DROP CONSTRAINT IF EXISTS valid_driver_type;
ALTER TABLE public.pos_hardware_configs DROP CONSTRAINT IF EXISTS valid_device_role;