
-- Fix the CHECK constraint to include 'payments'
ALTER TABLE migration_steps DROP CONSTRAINT IF EXISTS migration_steps_step_key_check;
ALTER TABLE migration_steps ADD CONSTRAINT migration_steps_step_key_check 
  CHECK (step_key = ANY (ARRAY[
    'config'::text, 'accounts'::text, 'contacts'::text, 'products'::text, 'trial_balance'::text, 
    'open_ar'::text, 'open_ap'::text, 'payments'::text, 'bank_balances'::text, 'inventory'::text, 
    'validation'::text, 'finalization'::text
  ]));

-- Delete orphaned sessions that have no steps (broken sessions)
DELETE FROM migration_batches 
WHERE session_id IN (
  SELECT ms.id FROM migration_sessions ms 
  LEFT JOIN migration_steps mst ON mst.session_id = ms.id 
  WHERE mst.id IS NULL
);

DELETE FROM migration_sessions 
WHERE id IN (
  SELECT ms.id FROM migration_sessions ms 
  LEFT JOIN migration_steps mst ON mst.session_id = ms.id 
  WHERE mst.id IS NULL
);
