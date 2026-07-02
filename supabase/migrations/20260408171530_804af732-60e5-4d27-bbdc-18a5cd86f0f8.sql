-- Temporarily disable the immutability trigger for this backfill
ALTER TABLE journal_entry_lines DISABLE TRIGGER trg_enforce_journal_entry_lines_immutability;

-- Backfill contact_id from source invoices
UPDATE journal_entry_lines jel
SET contact_id = i.contact_id
FROM journal_entries je
JOIN invoices i ON i.id = je.source_id AND je.source_type = 'invoice'
WHERE jel.journal_entry_id = je.id
  AND jel.contact_id IS NULL
  AND i.contact_id IS NOT NULL;

-- Backfill contact_id from source bills (using vendor_id)
UPDATE journal_entry_lines jel
SET contact_id = b.vendor_id
FROM journal_entries je
JOIN bills b ON b.id = je.source_id AND je.source_type = 'bill'
WHERE jel.journal_entry_id = je.id
  AND jel.contact_id IS NULL
  AND b.vendor_id IS NOT NULL;

-- Backfill contact_id from source payments (via linked invoice)
UPDATE journal_entry_lines jel
SET contact_id = i.contact_id
FROM journal_entries je
JOIN payments p ON p.id = je.source_id AND je.source_type = 'payment'
JOIN invoices i ON i.id = p.invoice_id
WHERE jel.journal_entry_id = je.id
  AND jel.contact_id IS NULL
  AND i.contact_id IS NOT NULL;

-- Re-enable the immutability trigger
ALTER TABLE journal_entry_lines ENABLE TRIGGER trg_enforce_journal_entry_lines_immutability;