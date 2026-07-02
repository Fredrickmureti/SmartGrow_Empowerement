-- Scanner cockpit Wave 6 — RLS + RPC catalog regression for wave-5 surface.
--
-- Locks the catalog-level invariants for:
--   * scanner_device_labels (RLS on, no broad anon SELECT)
--   * pos_rename_scanner_device  (SECURITY DEFINER, anon REVOKED)
--   * list_scan_events           (SECURITY DEFINER, anon REVOKED, code masked)
--
-- Static checks only — runs in any DB without fixture seeding.
\set ON_ERROR_STOP on

-- ============================================================
-- 1. scanner_device_labels: table exists + RLS enabled
-- ============================================================
DO $$
DECLARE rls_on boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.scanner_device_labels'::regclass
  ) THEN
    RAISE EXCEPTION 'scanner_device_labels table missing';
  END IF;

  SELECT relrowsecurity INTO rls_on
  FROM pg_class WHERE oid = 'public.scanner_device_labels'::regclass;
  IF NOT rls_on THEN
    RAISE EXCEPTION 'RLS not enabled on scanner_device_labels';
  END IF;
END $$;

-- ============================================================
-- 2. anon must not have direct SELECT/INSERT/UPDATE/DELETE
-- ============================================================
DO $$
DECLARE bad text[] := ARRAY[]::text[]; priv text;
BEGIN
  FOREACH priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE']
  LOOP
    IF has_table_privilege('anon', 'public.scanner_device_labels', priv) THEN
      bad := array_append(bad, priv);
    END IF;
  END LOOP;
  IF array_length(bad,1) > 0 THEN
    RAISE EXCEPTION 'anon has direct % on scanner_device_labels', bad;
  END IF;
END $$;

-- ============================================================
-- 3. RPCs exist; pos_rename_scanner_device is SECURITY DEFINER
--    (list_scan_events is invoker — relies on RLS on scan_events).
-- ============================================================
DO $$
DECLARE def boolean;
BEGIN
  SELECT prosecdef INTO def FROM pg_proc
   WHERE pronamespace='public'::regnamespace
     AND proname='pos_rename_scanner_device' LIMIT 1;
  IF def IS NULL THEN RAISE EXCEPTION 'pos_rename_scanner_device missing'; END IF;
  IF NOT def THEN RAISE EXCEPTION 'pos_rename_scanner_device must be SECURITY DEFINER'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname='list_scan_events'
  ) THEN
    RAISE EXCEPTION 'list_scan_events missing';
  END IF;
END $$;

-- ============================================================
-- 4. anon has NO EXECUTE on either RPC
-- ============================================================
DO $$
DECLARE fn text; sig text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['pos_rename_scanner_device','list_scan_events']
  LOOP
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
    INTO sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname = fn
    LIMIT 1;
    IF sig IS NOT NULL AND has_function_privilege('anon', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon has EXECUTE on %', sig;
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- 5. list_scan_events return exposes code_masked, NOT raw code
-- ============================================================
DO $$
DECLARE rt text;
BEGIN
  SELECT pg_get_function_result(p.oid) INTO rt
  FROM pg_proc p
  WHERE p.pronamespace='public'::regnamespace AND p.proname='list_scan_events'
  LIMIT 1;
  IF rt !~* 'code_masked' THEN
    RAISE EXCEPTION 'list_scan_events return missing code_masked: %', rt;
  END IF;
  IF rt ~* '(^|[,( ])code\s+(text|character)' THEN
    RAISE EXCEPTION 'list_scan_events return leaks raw code column: %', rt;
  END IF;
END $$;

SELECT 'scanner_device_labels_rls_test passed' AS status;
