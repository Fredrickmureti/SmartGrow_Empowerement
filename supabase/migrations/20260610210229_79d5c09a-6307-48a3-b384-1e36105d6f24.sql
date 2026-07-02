-- Eradicate legacy hr_statutory_field_config table.
-- Architecture moved to pack_requirements as single source of truth.
-- No app code, RPC, or FK references the legacy table (verified pre-migration).

DROP TABLE IF EXISTS public.hr_statutory_field_config CASCADE;