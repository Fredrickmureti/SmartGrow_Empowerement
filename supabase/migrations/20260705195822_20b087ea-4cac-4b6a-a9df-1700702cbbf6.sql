
-- Phase 1: parallel-workflow state columns on payroll_runs.
ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS posting_status text NOT NULL DEFAULT 'not_posted',
  ADD COLUMN IF NOT EXISTS posting_journal_entry_id uuid,
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS bank_file_status text NOT NULL DEFAULT 'not_generated',
  ADD COLUMN IF NOT EXISTS payslip_issuance_status text NOT NULL DEFAULT 'not_issued';

-- Value domains.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_runs_posting_status_chk') THEN
    ALTER TABLE public.payroll_runs
      ADD CONSTRAINT payroll_runs_posting_status_chk
      CHECK (posting_status IN ('not_posted','posted','reversed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_runs_payment_status_chk') THEN
    ALTER TABLE public.payroll_runs
      ADD CONSTRAINT payroll_runs_payment_status_chk
      CHECK (payment_status IN ('pending','partially_paid','fully_paid','on_hold'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_runs_bank_file_status_chk') THEN
    ALTER TABLE public.payroll_runs
      ADD CONSTRAINT payroll_runs_bank_file_status_chk
      CHECK (bank_file_status IN ('not_generated','generated','sent','acknowledged'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_runs_payslip_issuance_status_chk') THEN
    ALTER TABLE public.payroll_runs
      ADD CONSTRAINT payroll_runs_payslip_issuance_status_chk
      CHECK (payslip_issuance_status IN ('not_issued','issued','distributed'));
  END IF;
END $$;

-- Back-fill: honour legacy status labels so history is consistent.
UPDATE public.payroll_runs
   SET posting_status = 'posted',
       posting_journal_entry_id = COALESCE(posting_journal_entry_id, reclassification_journal_entry_id)
 WHERE status IN ('posted','paid') AND posting_status = 'not_posted';

UPDATE public.payroll_runs
   SET posting_status = 'reversed'
 WHERE status = 'reversed' AND posting_status <> 'reversed';

UPDATE public.payroll_runs
   SET payment_status = 'fully_paid'
 WHERE status = 'paid' AND payment_status = 'pending';

-- Helpful indexes for the workflow dashboards.
CREATE INDEX IF NOT EXISTS payroll_runs_posting_status_idx
  ON public.payroll_runs (organization_id, posting_status);
CREATE INDEX IF NOT EXISTS payroll_runs_payment_status_idx
  ON public.payroll_runs (organization_id, payment_status);
CREATE INDEX IF NOT EXISTS payroll_runs_approved_at_idx
  ON public.payroll_runs (organization_id, business_id, approved_at)
  WHERE approved_at IS NOT NULL;
