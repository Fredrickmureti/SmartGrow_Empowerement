-- Post all existing draft journal entries that are balanced
UPDATE journal_entries SET status = 'posted' 
WHERE status = 'draft'
  AND id IN (
    SELECT journal_entry_id 
    FROM (
      SELECT journal_entry_id, 
             ABS(SUM(debit) - SUM(credit)) as imbalance
      FROM journal_entry_lines 
      GROUP BY journal_entry_id
    ) balanced
    WHERE imbalance < 0.01
  );