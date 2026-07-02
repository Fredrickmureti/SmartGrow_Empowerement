DO $$
DECLARE
  v_je_id uuid;
BEGIN
  INSERT INTO journal_entries (
    organization_id, business_id, entry_number, entry_date, description,
    status, source_type, source_id, created_by
  ) VALUES (
    'a2b62719-2f78-4ceb-b851-edc74f70c324',
    'a6b5772c-02b3-4adc-97d8-2707a94b55b4',
    'JE-00008', '2026-03-09',
    'Invoice 00002 - Revenue recognition (remediation)',
    'posted', 'invoice', '38a09c98-302f-4d1f-861f-9ddbfb7ed76c',
    '4cf18944-4250-4199-af49-94bf32541fa7'
  ) RETURNING id INTO v_je_id;

  INSERT INTO journal_entry_lines (
    journal_entry_id, account_id, description, debit, credit, sort_order, contact_id
  ) VALUES
    (v_je_id, 'b02cdef1-2968-4624-bcdc-6f80fdc156fc', 'Invoice 00002 - Accounts Receivable', 4000, 0, 0, 'e9aa1f19-e950-4899-9302-78639deeb90f'),
    (v_je_id, '399f2ebc-80ff-4101-be54-610f316a92cc', 'Invoice 00002 - Sales Revenue', 0, 4000, 1, 'e9aa1f19-e950-4899-9302-78639deeb90f');

  UPDATE invoices SET journal_entry_id = v_je_id WHERE id = '38a09c98-302f-4d1f-861f-9ddbfb7ed76c';
END $$;