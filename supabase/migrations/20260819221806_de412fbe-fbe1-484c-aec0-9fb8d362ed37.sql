-- 1. Remove the legacy 3-argument reconcile overload. It duplicates the
--    branch-aware 4-argument version and, because both carry defaults, any
--    3-argument call was ambiguous ("function is not unique").
DROP FUNCTION IF EXISTS public.reconcile_inventory_subledger_to_gl(uuid, uuid, date);

-- 2. Revoke the default PUBLIC/anon EXECUTE on every inventory reporting and
--    diagnostic RPC; grant explicitly to authenticated + service_role.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'report_stock_ledger',
        'report_inventory_valuation_as_of',
        'check_inventory_valuation_drift',
        'check_valuation_writer_coverage',
        'check_movement_reversal_coverage',
        'reconcile_inventory_subledger_to_gl',
        'explain_inventory_gl_drift'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END
$$;