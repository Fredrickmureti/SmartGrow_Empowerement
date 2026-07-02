
-- Fix over-correction: the previous corrective entry was 1,500 too large
-- After voiding JE-18/19, the correct fix was Dr CustDep 1,000 / Cr AR 1,000
-- But we posted 2,500. This entry reverses the excess 1,500.

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
  SELECT organization_id, business_id INTO v_org_id, v_business_id
  FROM journal_entries WHERE entry_number = 'JE-00013' LIMIT 1;

  LOOP
    BEGIN
      v_je_number := generate_next_je_number(v_org_id);
      INSERT INTO journal_entries (
        organization_id, business_id, entry_number, entry_date,
        reference, description, source_type, source_id, status, created_by
      ) VALUES (
        v_org_id, v_business_id, v_je_number, CURRENT_DATE,
        'CORRECTION-002',
        'Fix over-correction: reverse excess 1,500 from CORRECTION-001',
        'adjustment', NULL, 'posted', NULL
      ) RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_retry := v_retry + 1;
      IF v_retry >= 10 THEN RAISE EXCEPTION 'JE number generation failed'; END IF;
    END;
  END LOOP;

  -- Dr AR 1,500 (restore from over-reduction)
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, v_ar_account_id, 1500, 0, 'Correction: reverse excess AR reduction');

  -- Cr Customer Deposits 1,500 (restore from over-reduction)
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, v_cd_account_id, 0, 1500, 'Correction: reverse excess Customer Deposits reduction');
END $$;

ALTER TABLE journal_entries ENABLE TRIGGER trg_enforce_journal_entry_immutability;

-- Recalculate current_balance for AR
UPDATE accounts SET current_balance = (
  SELECT COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0)
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  WHERE jel.account_id = 'b02cdef1-2968-4624-bcdc-6f80fdc156fc'
    AND je.status = 'posted'
) WHERE id = 'b02cdef1-2968-4624-bcdc-6f80fdc156fc';

-- Recalculate current_balance for Customer Deposits
UPDATE accounts SET current_balance = (
  SELECT COALESCE(SUM(jel.credit), 0) - COALESCE(SUM(jel.debit), 0)
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  WHERE jel.account_id = '4c265d7c-2750-4d9f-9748-dbcfeee75db4'
    AND je.status = 'posted'
) WHERE id = '4c265d7c-2750-4d9f-9748-dbcfeee75db4';
