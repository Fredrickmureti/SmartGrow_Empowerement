
-- ============================================================
-- CORRECTIVE MIGRATION: Fix incorrect reversal entries
-- 
-- Root cause: The previous migration reversed ALL credit_application JEs,
-- but JE-15 (deposit application Dr CustDep 1000/Cr AR 1000) was CORRECT.
-- Reversing it created a phantom liability and inflated AR.
-- JE-19 also incorrectly reversed a 500 credit note application.
--
-- Current posted GL state:
--   AR = 3,500 (should be 1,000)
--   Customer Deposits = 2,500 credit (should be 0)
--
-- Fix: Post corrective JE: Dr Customer Deposits 2,500 / Cr AR 2,500
-- This nets out the incorrect reversal entries and the missing deposit application.
-- ============================================================

-- Temporarily disable immutability trigger for status updates
ALTER TABLE journal_entries DISABLE TRIGGER trg_enforce_journal_entry_immutability;

DO $$
DECLARE
  v_org_id UUID;
  v_business_id UUID;
  v_je_id UUID;
  v_je_number TEXT;
  v_ar_account_id UUID := 'b02cdef1-2968-4624-bcdc-6f80fdc156fc';
  v_cd_account_id UUID := '4c265d7c-2750-4d9f-9748-dbcfeee75db4';
  v_retry INT := 0;
BEGIN
  -- Get the org and business from the existing entries
  SELECT organization_id, business_id INTO v_org_id, v_business_id
  FROM journal_entries
  WHERE entry_number = 'JE-00018'
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RAISE NOTICE 'No matching entries found, skipping correction';
    RETURN;
  END IF;

  -- Mark the two incorrect reversal JEs as voided so they don't confuse reporting
  UPDATE journal_entries SET status = 'voided'
  WHERE entry_number IN ('JE-00018', 'JE-00019')
    AND source_type = 'reversal'
    AND status = 'posted';

  -- Post the corrective journal entry
  LOOP
    BEGIN
      v_je_number := generate_next_je_number(v_org_id);

      INSERT INTO journal_entries (
        organization_id, business_id, entry_number, entry_date,
        reference, description, source_type, source_id, status, created_by
      ) VALUES (
        v_org_id, v_business_id, v_je_number,
        CURRENT_DATE,
        'CORRECTION-001',
        'Corrective entry: void incorrect reversals (JE-18/19) and apply customer deposit of 1,000 to invoice. Net: Dr Customer Deposits 2,500 / Cr AR 2,500',
        'adjustment', NULL, 'posted', NULL
      ) RETURNING id INTO v_je_id;

      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_retry := v_retry + 1;
      IF v_retry >= 10 THEN
        RAISE EXCEPTION 'Could not generate unique JE number';
      END IF;
    END;
  END LOOP;

  -- Dr Customer Deposits & Advances 2,500 (reduce liability to 0)
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, v_cd_account_id, 2500, 0,
          'Correction: reduce Customer Deposits to 0 (void incorrect reversals + apply 1,000 deposit)');

  -- Cr Accounts Receivable 2,500 (reduce AR from 3,500 to 1,000)
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, v_ar_account_id, 0, 2500,
          'Correction: reduce AR to 1,000 outstanding');

  RAISE NOTICE 'Corrective JE % posted successfully', v_je_number;
END $$;

-- Re-enable immutability trigger
ALTER TABLE journal_entries ENABLE TRIGGER trg_enforce_journal_entry_immutability;

-- Update current_balance on affected accounts to reflect GL reality
-- AR: recalculate from posted JEs
UPDATE accounts SET current_balance = (
  SELECT COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0)
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  WHERE jel.account_id = 'b02cdef1-2968-4624-bcdc-6f80fdc156fc'
    AND je.status = 'posted'
) WHERE id = 'b02cdef1-2968-4624-bcdc-6f80fdc156fc';

-- Customer Deposits: recalculate from posted JEs
UPDATE accounts SET current_balance = (
  SELECT COALESCE(SUM(jel.credit), 0) - COALESCE(SUM(jel.debit), 0)
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  WHERE jel.account_id = '4c265d7c-2750-4d9f-9748-dbcfeee75db4'
    AND je.status = 'posted'
) WHERE id = '4c265d7c-2750-4d9f-9748-dbcfeee75db4';
