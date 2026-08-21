-- Guard: a refund must post to the bank's GENERAL LEDGER account, never to the
-- `bank_accounts.id` row identifier.
--
-- Both refund engines previously passed `_bank_account_id` straight into the
-- journal line's `account_id`, so every refund either tripped the cross-company
-- posting guard or pointed at an account that does not exist.
DO $$
DECLARE fn text; src text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['refund_customer_atomic','refund_from_vendor_atomic'] LOOP
    SELECT p.prosrc INTO src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = fn;
    IF src IS NULL THEN RAISE EXCEPTION '% is missing', fn; END IF;
    IF src ~ '''account_id'',\s*_bank_account_id' THEN
      RAISE EXCEPTION '% posts the bank record id as a ledger account', fn;
    END IF;
    IF src !~ 'account_id\s+INTO\s+v_bank_gl' THEN
      RAISE EXCEPTION '% does not resolve the bank GL account', fn;
    END IF;
  END LOOP;
END $$;
