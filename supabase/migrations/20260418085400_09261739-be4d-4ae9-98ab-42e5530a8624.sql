-- Stage A: Drop legacy AP posting triggers + add uniqueness guard

-- 1. Drop bill confirmation trigger and its function
DROP TRIGGER IF EXISTS trigger_bill_journal_entry ON public.bills;
DROP FUNCTION IF EXISTS public.create_bill_journal_entry();

-- 2. Drop bill payment trigger and its function
DROP TRIGGER IF EXISTS trigger_bill_payment_journal_entry ON public.bill_payments;
DROP FUNCTION IF EXISTS public.create_bill_payment_journal_entry();

-- 3. Structural guard: only one posted JE per source document
-- Prevents any future regression where two posting authorities both write a JE
-- for the same (organization, source_type, source_id) triple.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_je_per_source
  ON public.journal_entries (organization_id, source_type, source_id)
  WHERE source_type IS NOT NULL
    AND source_id IS NOT NULL
    AND status = 'posted';