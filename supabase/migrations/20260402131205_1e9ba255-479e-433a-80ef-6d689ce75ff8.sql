-- Void the orphan journal entry JE-00001 which has null source_type/source_id
-- and is not linked to any bill, creating a data integrity issue.
-- The trg_sync_balances_on_je_status trigger will automatically reverse 
-- the balance impact when status changes from 'posted' to 'voided'.

UPDATE public.journal_entries
SET 
  status = 'voided',
  voided_at = now(),
  void_reason = 'Orphan journal entry — no linked source document (null source_type/source_id). Voided during accounting integrity audit.'
WHERE id = '61edb7af-c732-4716-abdc-d20d2d989f21'
  AND status = 'posted'
  AND source_type IS NULL
  AND source_id IS NULL;