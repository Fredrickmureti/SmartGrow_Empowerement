DO $$
DECLARE
  r record;
  dropped int := 0;
  skipped int := 0;
BEGIN
  FOR r IN
    WITH f AS (
      SELECT p.oid, p.prosrc
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
        AND p.proname NOT LIKE 'mf\_%'
    ),
    refs AS (
      SELECT f.oid, lower(m[1]) AS rel
      FROM f, regexp_matches(f.prosrc, '(?:from|join|update|into)\s+public\.([a-z_][a-z0-9_]*)', 'gi') m
    ),
    missing AS (
      SELECT DISTINCT rf.oid
      FROM refs rf
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n2 ON n2.oid = c.relnamespace
        WHERE n2.nspname = 'public' AND c.relname = rf.rel
      )
    )
    SELECT m.oid, p.oid::regprocedure AS sig
    FROM missing m
    JOIN pg_proc p ON p.oid = m.oid
    WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = m.oid AND NOT t.tgisinternal)
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.refobjid = m.oid AND d.deptype = 'n')
  LOOP
    BEGIN
      EXECUTE format('DROP FUNCTION %s', r.sig);
      dropped := dropped + 1;
    EXCEPTION WHEN OTHERS THEN
      skipped := skipped + 1;
    END;
  END LOOP;
  RAISE NOTICE 'orphan function purge: dropped %, skipped %', dropped, skipped;
END $$;