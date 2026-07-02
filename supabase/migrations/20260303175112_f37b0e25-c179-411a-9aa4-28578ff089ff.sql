
-- Step 1: Void the broken wash entry (only change status, trigger allows this)
UPDATE journal_entries
SET status = 'voided'
WHERE id = '904d3ef1-0144-42e8-82b7-cf7536f67f87';

-- Step 2: Create correct INVOICE journal entry (revenue recognition)
INSERT INTO journal_entries (
  id, organization_id, business_id, entry_number, entry_date, description,
  reference, status, source_type, source_id, created_by, is_closing, is_adjusting
) VALUES (
  gen_random_uuid(),
  'a2b62719-2f78-4ceb-b851-edc74f70c324',
  'a20252aa-fd05-4826-9a83-da3165c12e6f',
  'JE-00002',
  '2026-03-03',
  'Invoice 00001 confirmed — revenue recognition',
  '00001',
  'posted',
  'invoice',
  '7e846485-fa59-4be4-903c-b0f787197a4e',
  '4cf18944-4250-4199-af49-94bf32541fa7',
  false,
  false
);

INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, contact_id)
SELECT je.id, '47a0efeb-0ab8-48f8-b40a-b0db5f684d39', 20000, 0, 'Invoice 00001 - Accounts Receivable', '270bce04-bba3-4671-82a8-7785eec88275'
FROM journal_entries je WHERE je.entry_number = 'JE-00002' AND je.organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324' AND je.status = 'posted';

INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, contact_id)
SELECT je.id, '634b90a0-e341-44e9-9468-6fc08e161b5c', 0, 20000, 'Invoice 00001 - Sales Revenue', '270bce04-bba3-4671-82a8-7785eec88275'
FROM journal_entries je WHERE je.entry_number = 'JE-00002' AND je.organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324' AND je.status = 'posted';

-- Step 3: Create correct PAYMENT journal entry
INSERT INTO journal_entries (
  id, organization_id, business_id, entry_number, entry_date, description,
  reference, status, source_type, source_id, created_by, is_closing, is_adjusting
) VALUES (
  gen_random_uuid(),
  'a2b62719-2f78-4ceb-b851-edc74f70c324',
  'a20252aa-fd05-4826-9a83-da3165c12e6f',
  'JE-00003',
  '2026-03-03',
  'Payment received - 00001 - RCP-000001',
  'RCP-000001',
  'posted',
  'payment',
  'c21692ac-4e13-4759-a7ad-6902b5ef5651',
  '4cf18944-4250-4199-af49-94bf32541fa7',
  false,
  false
);

INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, contact_id)
SELECT je.id, 'de523e50-152e-4d34-9761-b08c5f391e22', 20000, 0, 'Payment RCP-000001 - Cash Receipt', '270bce04-bba3-4671-82a8-7785eec88275'
FROM journal_entries je WHERE je.entry_number = 'JE-00003' AND je.organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324' AND je.status = 'posted';

INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, contact_id)
SELECT je.id, '47a0efeb-0ab8-48f8-b40a-b0db5f684d39', 0, 20000, 'Payment RCP-000001 - AR Reduction', '270bce04-bba3-4671-82a8-7785eec88275'
FROM journal_entries je WHERE je.entry_number = 'JE-00003' AND je.organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324' AND je.status = 'posted';
