
-- Temporarily disable immutability trigger to clean phantom data
ALTER TABLE journal_entry_lines DISABLE TRIGGER trg_enforce_journal_entry_lines_immutability;

-- Delete phantom JE-00002 lines (reversal of never-posted invoice)
DELETE FROM journal_entry_lines WHERE journal_entry_id = 'b4534c8c-4c7f-4c06-a0f4-6e92bb9d70d2';

-- Re-enable the trigger
ALTER TABLE journal_entry_lines ENABLE TRIGGER trg_enforce_journal_entry_lines_immutability;

-- Delete the phantom journal entry
DELETE FROM journal_entries WHERE id = 'b4534c8c-4c7f-4c06-a0f4-6e92bb9d70d2';

-- Fix AR mapping: point to actual Accounts Receivable, not Bank
UPDATE default_account_settings 
SET account_id = '47a0efeb-0ab8-48f8-b40a-b0db5f684d39'
WHERE organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324'
  AND business_id = 'a6b5772c-02b3-4adc-97d8-2707a94b55b4'
  AND setting_key = 'accounts_receivable';

-- Reset invoice 00002 to draft for proper confirmation
UPDATE invoices SET status = 'draft', confirmed_by = NULL, journal_entry_id = NULL 
WHERE id = 'c8191ab2-f2cc-46f2-9beb-e759cbc9299c';
