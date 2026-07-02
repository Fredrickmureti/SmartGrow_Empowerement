-- Backfill: link existing void JEs to their originals
-- source_id is UUID, so we need to cast for LIKE comparison
UPDATE public.journal_entries AS reversal
SET reversal_of_id = original.id
FROM public.journal_entries AS original
WHERE reversal.source_id::text LIKE 'void-%'
  AND reversal.reversal_of_id IS NULL
  AND original.source_type = reversal.source_type
  AND original.source_id::text = REPLACE(reversal.source_id::text, 'void-', '')
  AND original.organization_id = reversal.organization_id;