-- Remove a leftover scratch DDL statement from finance_cash_flow_statement.
-- A STABLE function may not execute DDL: `CREATE TEMP TABLE ...` would raise
-- "cannot execute CREATE TABLE in a read-only transaction" at call time.
-- Everything else is byte-identical to the Phase 2 definition.
DO $do$
DECLARE
  v_src text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'finance_cash_flow_statement';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'finance_cash_flow_statement is missing';
  END IF;

  v_new := replace(
    v_src,
    '  CREATE TEMP TABLE IF NOT EXISTS _cf_scratch_dummy(x int) ON COMMIT DROP;' || E'\n' || E'\n',
    ''
  );

  IF v_new = v_src THEN
    RAISE EXCEPTION 'scratch statement not found — refusing to redefine blindly';
  END IF;

  EXECUTE v_new;
END
$do$;

DO $check$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'finance_cash_flow_statement'
       AND p.prosrc ILIKE '%_cf_scratch_dummy%'
  ) THEN
    RAISE EXCEPTION 'scratch statement still present in finance_cash_flow_statement';
  END IF;
END
$check$;