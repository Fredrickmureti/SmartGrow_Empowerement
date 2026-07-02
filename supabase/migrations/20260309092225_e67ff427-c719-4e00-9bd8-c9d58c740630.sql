-- Void the duplicate trigger-created payment journal entry (JE-00002)
-- This was created by the now-removed trigger and duplicates JE-00003
UPDATE journal_entries 
SET status = 'voided'
WHERE source_type IS NULL 
  AND source_id IS NULL
  AND status = 'posted'
  AND description LIKE 'Payment received%';