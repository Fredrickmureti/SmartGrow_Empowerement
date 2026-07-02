ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS posted_by_id uuid,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_reason text;

ALTER TABLE public.journal_entries DISABLE TRIGGER USER;
UPDATE public.journal_entries
   SET posted_by_id = posted_by
 WHERE posted_by_id IS NULL AND posted_by IS NOT NULL;
ALTER TABLE public.journal_entries ENABLE TRIGGER USER;

CREATE INDEX IF NOT EXISTS idx_journal_entries_posted_by_id
  ON public.journal_entries(posted_by_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_reversed_at
  ON public.journal_entries(reversed_at);