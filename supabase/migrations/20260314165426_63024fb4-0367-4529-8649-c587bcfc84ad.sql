
-- ================================================================
-- Correcting Journal Entry: Reclassify credit note mispostings
-- from Accounts Receivable to Customer Deposits & Advances
-- ================================================================
-- Two credit notes (CN-2026-2026) totaling 1,000 KES were incorrectly
-- posted to Accounts Receivable instead of Customer Deposits for
-- fully paid invoices (INV-00003 and INV-00004).
-- 
-- Correction: DR Accounts Receivable 1,000 / CR Customer Deposits 1,000
-- This reverses the incorrect AR credit and places it correctly as a liability.
-- ================================================================

DO $$
DECLARE
  v_je_id UUID;
  v_org_id UUID := 'a2b62719-2f78-4ceb-b851-edc74f70c324';
  v_biz_id UUID := 'a6b5772c-02b3-4adc-97d8-2707a94b55b4';
  v_ar_account_id UUID := 'b02cdef1-2968-4624-bcdc-6f80fdc156fc';
  v_cd_account_id UUID := '4c265d7c-2750-4d9f-9748-dbcfeee75db4';
BEGIN
  -- Create the correcting journal entry
  INSERT INTO journal_entries (
    id, organization_id, business_id, entry_number, entry_date,
    description, reference, is_adjusting, status, posted_at,
    source_type, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_org_id, v_biz_id, 'JE-00024',
    CURRENT_DATE,
    'Reclassification: Credit notes on fully paid invoices (INV-00003, INV-00004) — correcting misposting from Accounts Receivable to Customer Deposits & Advances',
    'ADJ-CN-RECLASS-001',
    true, 'posted', NOW(),
    'manual', NOW(), NOW()
  ) RETURNING id INTO v_je_id;

  -- Line 1: DR Accounts Receivable 1,000 (reverse the incorrect CR)
  INSERT INTO journal_entry_lines (
    journal_entry_id, account_id, debit, credit, description, sort_order
  ) VALUES (
    v_je_id, v_ar_account_id, 1000, 0,
    'Reclassification: Reverse incorrect AR credit from credit notes CN-2026-2026 on fully paid invoices',
    1
  );

  -- Line 2: CR Customer Deposits & Advances 1,000 (correct posting)
  INSERT INTO journal_entry_lines (
    journal_entry_id, account_id, debit, credit, description, sort_order
  ) VALUES (
    v_je_id, v_cd_account_id, 0, 1000,
    'Reclassification: Credit notes CN-2026-2026 on fully paid invoices — customer liability recognized',
    2
  );

  -- Update account balances
  UPDATE accounts SET current_balance = current_balance + 1000 WHERE id = v_ar_account_id;
  UPDATE accounts SET current_balance = current_balance - 1000 WHERE id = v_cd_account_id;
END $$;
