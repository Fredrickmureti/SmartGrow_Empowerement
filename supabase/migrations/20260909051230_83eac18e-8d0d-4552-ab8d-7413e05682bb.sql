CREATE OR REPLACE FUNCTION public.reset_module__banking(org_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  IF to_regclass('public.bank_reconciliation_writeoffs') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM bank_reconciliation_writeoffs w USING bank_reconciliation_sessions s WHERE w.session_id = s.id AND s.organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('bank_reconciliation_writeoffs', n);
  END IF;
  IF to_regclass('public.bank_reconciliation_matches') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM bank_reconciliation_matches WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('bank_reconciliation_matches', n);
  END IF;
  IF to_regclass('public.bank_reconciliation_items') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM bank_reconciliation_items i USING bank_reconciliation_sessions s WHERE i.session_id = s.id AND s.organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('bank_reconciliation_items', n);
  END IF;
  IF to_regclass('public.bank_reconciliation_sessions') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM bank_reconciliation_sessions WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('bank_reconciliation_sessions', n);
  END IF;
  IF to_regclass('public.bank_transactions') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM bank_transactions WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('bank_transactions', n);
  END IF;
  IF to_regclass('public.bank_statements') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM bank_statements WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('bank_statements', n);
  END IF;
  RETURN v;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.reset_module__transactions_ledger(org_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  IF to_regclass('public.payment_allocations') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM payment_allocations a USING payments p WHERE a.payment_id = p.id AND p.organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('payment_allocations', n);
  END IF;
  IF to_regclass('public.payments') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM payments WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('payments', n);
  END IF;
  IF to_regclass('public.fx_revaluation_lines') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM fx_revaluation_lines l USING fx_revaluation_runs r WHERE l.run_id = r.id AND r.organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('fx_revaluation_lines', n);
  END IF;
  IF to_regclass('public.fx_revaluation_runs') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM fx_revaluation_runs WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('fx_revaluation_runs', n);
  END IF;
  IF to_regclass('public.accounting_events') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM accounting_events WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('accounting_events', n);
  END IF;
  IF to_regclass('public.transactions') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM transactions WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('transactions', n);
  END IF;
  RETURN v;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.reset_module__sequences(org_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  IF to_regclass('public.invoice_sequences') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM invoice_sequences WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('invoice_sequences', n);
  END IF;
  IF to_regclass('public.je_number_sequences') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM je_number_sequences WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('je_number_sequences', n);
  END IF;
  IF to_regclass('public.document_number_counters') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM document_number_counters c USING businesses b WHERE c.business_id = b.id AND b.organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('document_number_counters', n);
  END IF;
  RETURN v;
END;
$fn$;