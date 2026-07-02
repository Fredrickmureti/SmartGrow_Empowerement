-- Fix: Update the sequence to be safely ahead of any existing entries
-- The upsert pattern means the NEXT call will return last_number + 1
-- So we need last_number = current max (5), and the next call produces 6
-- But if 6 already exists from a failed partial insert, let's check and go higher

-- Also fix a subtle bug: the first call after seed does INSERT with value 1,
-- conflicts, then sets last_number = 5 + 1 = 6. That's correct.
-- But if someone called the function between seed and now, it already incremented.
-- Let's just re-sync to be safe.

UPDATE je_number_sequences 
SET last_number = (
  SELECT COALESCE(MAX(
    CASE WHEN entry_number ~ '^JE-[0-9]+$'
         THEN CAST(SUBSTRING(entry_number FROM 4) AS INT)
         ELSE 0 END
  ), 0)
  FROM journal_entries 
  WHERE organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324'
)
WHERE organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324';