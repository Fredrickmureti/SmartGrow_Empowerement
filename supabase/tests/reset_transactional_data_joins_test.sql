-- Regression guard (2026-09-09): the transactional reset must scope each
-- table by a column that actually exists in the microfinance schema.
-- Two live failures were caused by invented columns:
--   * bank_reconciliation_writeoffs.session_id  (real link: reconciliation_match_id)
--   * accounting_events.organization_id         (real link: business_id)

DO $$
DECLARE v_banking text; v_ledger text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_banking
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reset_module__banking';

  SELECT pg_get_functiondef(p.oid) INTO v_ledger
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reset_module__transactions_ledger';

  IF v_banking IS NULL OR v_ledger IS NULL THEN
    RAISE EXCEPTION 'reset module functions are missing';
  END IF;

  IF v_banking ~ 'w\.session_id' THEN
    RAISE EXCEPTION 'reset_module__banking joins write-offs on a non-existent session_id column';
  END IF;

  IF v_banking !~ 'reconciliation_match_id' THEN
    RAISE EXCEPTION 'reset_module__banking must join write-offs via reconciliation_match_id';
  END IF;

  IF v_ledger ~ 'DELETE FROM accounting_events WHERE organization_id' THEN
    RAISE EXCEPTION 'reset_module__transactions_ledger scopes accounting_events by a non-existent organization_id column';
  END IF;

  IF v_ledger !~ 'accounting_events e USING businesses b' THEN
    RAISE EXCEPTION 'reset_module__transactions_ledger must scope accounting_events through businesses';
  END IF;
END $$;
