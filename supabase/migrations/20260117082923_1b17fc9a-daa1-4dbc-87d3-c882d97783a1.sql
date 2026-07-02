-- First, close all but the most recent open shift per user/register combination
WITH ranked_shifts AS (
  SELECT 
    id,
    user_id,
    register_id,
    opened_at,
    ROW_NUMBER() OVER (PARTITION BY user_id, register_id ORDER BY opened_at DESC) as rn
  FROM pos_shifts
  WHERE status = 'open'
)
UPDATE pos_shifts 
SET 
  status = 'closed',
  closed_at = NOW(),
  notes = COALESCE(notes || ' | ', '') || 'Auto-closed: duplicate open shift cleanup'
WHERE id IN (
  SELECT id FROM ranked_shifts WHERE rn > 1
);

-- Create unique partial index to prevent multiple open shifts per user/register
CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_shifts_one_open_per_user_register 
ON pos_shifts (user_id, register_id) 
WHERE status = 'open';