
-- Corrective Journal Entry: Reclassify customer overpayment from AP to Customer Deposits
-- This is a DATA correction for a historical misposting, not a schema change.
-- The original JE (cc9c887a-...) is preserved for audit trail.

DO $$
DECLARE
  v_org_id UUID := 'a2b62719-2f78-4ceb-b851-edc74f70c324';
  v_business_id UUID := 'a6b5772c-02b3-4adc-97d8-2707a94b55b4';
  v_ap_account_id UUID := 'b221bef2-774a-4d80-9bc7-3cc4b4f27a17';       -- 2000 Accounts Payable
  v_cust_dep_account_id UUID := '4c265d7c-2750-4d9f-9748-dbcfeee75db4'; -- 2001 Customer Deposits & Advances
  v_je_id UUID;
  v_je_number TEXT;
BEGIN
  -- Generate JE number
  v_je_number := generate_next_je_number(v_org_id);

  -- Create corrective journal entry
  INSERT INTO journal_entries (
    organization_id, business_id, entry_number, entry_date,
    reference, description, source_type, status
  ) VALUES (
    v_org_id, v_business_id, v_je_number,
    CURRENT_DATE,
    'ADJ-RECLASS-001',
    'Reclassification: customer overpayment on INV-00003 moved from Accounts Payable (2000) to Customer Deposits & Advances (2001)',
    'adjustment', 'posted'
  ) RETURNING id INTO v_je_id;

  -- Dr Accounts Payable 1,000 (reduce the incorrect liability)
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, v_ap_account_id, 1000, 0, 'Reverse incorrect overpayment posting to AP - INV 00003');

  -- Cr Customer Deposits & Advances 1,000 (record correct liability)
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, v_cust_dep_account_id, 0, 1000, 'Reclassify customer overpayment to Customer Deposits - INV 00003');
END;
$$;
