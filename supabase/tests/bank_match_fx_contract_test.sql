-- Structural contract: bank_match_confirm and FX (ADR 0136).
--
-- Two regressions this locks down, both found in Phase 6:
--   1. bank_match_confirm handed a caller-computed `_exchange_rate` to
--      record_multi_invoice_payment / record_multi_bill_payment. Those engines
--      resolve their own rate and reject a supplied one, so *every* invoice or
--      bill match confirmation raised.
--   2. a statement line without `original_currency` fell back to the company's
--      base currency, valuing a foreign bank account's line at parity. The bank
--      account's own currency is authoritative when the line does not say.
--
-- Read-only: safe to run anywhere.
DO $$
DECLARE
  d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'bank_match_confirm';
  IF d IS NULL THEN RAISE EXCEPTION 'FAIL bank_match_confirm is missing'; END IF;

  IF d ~ '_exchange_rate\s*:=' THEN
    RAISE EXCEPTION 'FAIL bank_match_confirm passes _exchange_rate to a settlement engine; rates are resolved server-side (ADR 0136)';
  END IF;

  IF d !~ 'FROM public\.bank_accounts ba WHERE ba\.id = _txn\.bank_account_id' THEN
    RAISE EXCEPTION 'FAIL bank_match_confirm no longer falls back to the bank account currency for an unlabelled statement line';
  END IF;

  IF d !~ 'require_exchange_rate' THEN
    RAISE EXCEPTION 'FAIL bank_match_confirm must resolve its rate through require_exchange_rate';
  END IF;

  RAISE NOTICE 'PASS bank_match_confirm FX contract';
END $$;
