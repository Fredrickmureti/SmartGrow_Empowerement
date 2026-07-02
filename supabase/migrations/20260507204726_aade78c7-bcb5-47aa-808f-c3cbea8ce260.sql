ALTER TABLE public.payroll_payment_batches
  ADD COLUMN IF NOT EXISTS payment_journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_payment_batches_payment_je
  ON public.payroll_payment_batches(payment_journal_entry_id)
  WHERE payment_journal_entry_id IS NOT NULL;