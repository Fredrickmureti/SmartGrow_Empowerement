DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND (c.relname LIKE 'pos\_%' OR c.relname LIKE 'v\_pos\_%')
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.relname);
  END LOOP;

  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'v'
      AND (c.relname LIKE 'pos\_%' OR c.relname LIKE 'v\_pos\_%')
  LOOP
    EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', r.relname);
  END LOOP;
END $$;