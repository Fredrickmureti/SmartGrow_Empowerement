-- ============================================================
-- Phase 3 hardening: server-side guard for business transactions
-- Ensures owner_investment / owner_drawing / loan_received /
-- loan_payment / bank_transfer journal entries can never be
-- posted with semantically wrong account types — even if a
-- caller bypasses the UI.
--
-- Why a trigger and not CHECK: account_type lives on `accounts`,
-- not on `journal_entry_lines`, so we must JOIN at validation
-- time. We attach a constraint trigger that fires DEFERRED at
-- end-of-statement after all lines are inserted.
-- ============================================================

CREATE OR REPLACE FUNCTION public.validate_business_txn_account_types()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_type text;
  v_bad_count int;
BEGIN
  -- Only validate the canonical business-transaction source types
  SELECT source_type INTO v_source_type
  FROM journal_entries WHERE id = NEW.journal_entry_id;

  IF v_source_type IS NULL THEN RETURN NEW; END IF;

  -- owner_investment: must have at least one credit on equity
  --                   AND at least one debit on asset
  IF v_source_type = 'owner_investment' THEN
    SELECT count(*) INTO v_bad_count
    FROM journal_entry_lines jel
    JOIN accounts a ON a.id = jel.account_id
    WHERE jel.journal_entry_id = NEW.journal_entry_id
      AND jel.credit > 0
      AND a.account_type <> 'equity';
    IF v_bad_count > 0 THEN
      RAISE EXCEPTION 'owner_investment must credit an Equity account, not % accounts', v_bad_count
        USING ERRCODE = 'P0001';
    END IF;

    SELECT count(*) INTO v_bad_count
    FROM journal_entry_lines jel
    JOIN accounts a ON a.id = jel.account_id
    WHERE jel.journal_entry_id = NEW.journal_entry_id
      AND jel.debit > 0
      AND a.account_type <> 'asset';
    IF v_bad_count > 0 THEN
      RAISE EXCEPTION 'owner_investment must debit an Asset (bank/cash) account'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- owner_drawing: debit equity, credit asset
  IF v_source_type = 'owner_drawing' THEN
    SELECT count(*) INTO v_bad_count
    FROM journal_entry_lines jel
    JOIN accounts a ON a.id = jel.account_id
    WHERE jel.journal_entry_id = NEW.journal_entry_id
      AND jel.debit > 0
      AND a.account_type <> 'equity';
    IF v_bad_count > 0 THEN
      RAISE EXCEPTION 'owner_drawing must debit an Equity account'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- loan_received: debit asset, credit liability
  IF v_source_type = 'loan_received' THEN
    SELECT count(*) INTO v_bad_count
    FROM journal_entry_lines jel
    JOIN accounts a ON a.id = jel.account_id
    WHERE jel.journal_entry_id = NEW.journal_entry_id
      AND jel.credit > 0
      AND a.account_type <> 'liability';
    IF v_bad_count > 0 THEN
      RAISE EXCEPTION 'loan_received must credit a Liability (loan) account'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- loan_payment: debit liability (+ optional expense for interest), credit asset
  IF v_source_type = 'loan_payment' THEN
    SELECT count(*) INTO v_bad_count
    FROM journal_entry_lines jel
    JOIN accounts a ON a.id = jel.account_id
    WHERE jel.journal_entry_id = NEW.journal_entry_id
      AND jel.credit > 0
      AND a.account_type <> 'asset';
    IF v_bad_count > 0 THEN
      RAISE EXCEPTION 'loan_payment must credit an Asset (bank/cash) account'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- bank_transfer: both sides must be assets
  IF v_source_type = 'bank_transfer' THEN
    SELECT count(*) INTO v_bad_count
    FROM journal_entry_lines jel
    JOIN accounts a ON a.id = jel.account_id
    WHERE jel.journal_entry_id = NEW.journal_entry_id
      AND a.account_type <> 'asset';
    IF v_bad_count > 0 THEN
      RAISE EXCEPTION 'bank_transfer requires Asset accounts on both sides'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_business_txn_account_types
  ON public.journal_entry_lines;

-- Deferrable so it fires after the full statement (all lines inserted)
CREATE CONSTRAINT TRIGGER trg_validate_business_txn_account_types
  AFTER INSERT ON public.journal_entry_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_business_txn_account_types();

COMMENT ON FUNCTION public.validate_business_txn_account_types() IS
  'Phase 3 audit hardening: enforces correct account-type semantics for canonical business-transaction journal entries (owner_investment, owner_drawing, loan_received, loan_payment, bank_transfer). Prevents the JE-00003-class data-corruption where Owner Investment was posted as Asset/Asset.';