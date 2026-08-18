-- Phase 4c — close the banking privilege category (V1, V2, V3)

DO $$
DECLARE
  t text;
  banking_tables text[] := ARRAY[
    'bank_accounts','bank_transactions','bank_statements',
    'bank_reconciliation_sessions','bank_reconciliation_items',
    'bank_reconciliation_matches','bank_reconciliation_writeoffs',
    'bank_transaction_splits','bank_reconciliation_rules',
    'transaction_categorization_rules'
  ];
BEGIN
  FOREACH t IN ARRAY banking_tables LOOP
    IF to_regclass('public.'||t) IS NULL THEN CONTINUE; END IF;
    -- anon must hold nothing on financial tables; RLS is not the only barrier
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    -- a read role must never be able to destroy the table contents
    EXECUTE format('REVOKE TRUNCATE ON public.%I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

-- Server-engine-only tables: written exclusively by SECURITY DEFINER seams
REVOKE INSERT, UPDATE, DELETE ON public.bank_reconciliation_matches FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.bank_reconciliation_writeoffs FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.bank_transaction_splits FROM authenticated;

-- Rule tables keep their client write grants until the Phase 4d write seam lands.
GRANT INSERT, UPDATE, DELETE ON public.bank_reconciliation_rules TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.transaction_categorization_rules TO authenticated;

-- Function EXECUTE: authenticated + service_role only, never PUBLIC/anon
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (
        p.proname LIKE 'bank\_%' ESCAPE '\'
        OR p.proname LIKE '\_bank\_%' ESCAPE '\'
        OR p.proname IN (
          'reconcile_bank_transaction_atomic',
          'reconcile_bank_transfer_atomic',
          'unreconcile_bank_transaction'
        )
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);
  END LOOP;
END $$;