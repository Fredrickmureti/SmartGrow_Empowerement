
-- Add is_reversal boolean column
ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS is_reversal boolean NOT NULL DEFAULT false;

-- Backfill: mark all JEs that have reversal_of_id as is_reversal = true
UPDATE public.journal_entries
SET is_reversal = true
WHERE reversal_of_id IS NOT NULL;

-- Backfill: also mark JEs with is_reversing = true
UPDATE public.journal_entries
SET is_reversal = true
WHERE is_reversing = true;

-- Backfill: set reversed_by_id on originals and mark them as "reversed"
-- For each reversal JE, update the original it points to
UPDATE public.journal_entries AS original
SET
  reversed_by_id = reversal.id,
  status = 'reversed'
FROM public.journal_entries AS reversal
WHERE reversal.reversal_of_id = original.id
  AND reversal.reversal_of_id IS NOT NULL
  AND original.status IN ('posted', 'voided');
