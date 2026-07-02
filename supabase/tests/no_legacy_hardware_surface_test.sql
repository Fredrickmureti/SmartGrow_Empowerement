-- Phase B drift guard — the live counterpart of
-- src/test/architecture/no-legacy-pos-hardware-configs.test.ts.
-- That test only scans src/; this one asserts the *database* itself
-- never regrows the legacy `pos_hardware_configs` table or any trigger
-- / function body that references it.
--
-- If this test fails, a migration somewhere re-created the legacy
-- mirror — fix the migration, do not weaken this test.

BEGIN;
SELECT plan(3);

-- 1. The legacy table is gone.
SELECT is(
  to_regclass('public.pos_hardware_configs')::text,
  NULL,
  'pos_hardware_configs table must not exist'
);

-- 2. No trigger on device_assignments references the legacy surface.
SELECT is(
  (SELECT count(*)::int
     FROM pg_trigger t
     JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.device_assignments'::regclass
      AND NOT t.tgisinternal
      AND (pg_get_functiondef(p.oid) ILIKE '%pos_hardware_configs%'
        OR pg_get_functiondef(p.oid) ILIKE '%source_assignment_id%')),
  0,
  'no device_assignments trigger may reference pos_hardware_configs / source_assignment_id'
);

-- 3. No function in the public schema references the legacy surface.
SELECT is(
  (SELECT count(*)::int
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (pg_get_functiondef(p.oid) ILIKE '%pos_hardware_configs%'
        OR pg_get_functiondef(p.oid) ILIKE '%source_assignment_id%')),
  0,
  'no public.* function may reference pos_hardware_configs / source_assignment_id'
);

SELECT * FROM finish();
ROLLBACK;