-- 1. Drop broken legacy triggers and their functions (all call routines/tables that no longer exist)
DROP TRIGGER IF EXISTS trg_seed_pos_payment_methods ON public.businesses;
DROP FUNCTION IF EXISTS public.trg_seed_pos_payment_methods_fn();

DROP TRIGGER IF EXISTS trg_default_account_settings_payroll_role ON public.default_account_settings;
DROP FUNCTION IF EXISTS public._payroll_default_account_role_trigger();

DROP TRIGGER IF EXISTS trg_enforce_payroll_je_account_class ON public.journal_entry_lines;
DROP FUNCTION IF EXISTS public._payroll_je_line_class_trigger();

DROP TRIGGER IF EXISTS trg_wms_count_trigger_from_event ON public.business_event_outbox;
DROP FUNCTION IF EXISTS public._wms_count_trigger_from_event();

DROP TRIGGER IF EXISTS trg_cascade_branch_payments ON public.payments;
DROP TRIGGER IF EXISTS trg_cascade_branch_payment_allocations ON public.payment_allocations;
DROP FUNCTION IF EXISTS public.cascade_branch_from_invoice();

-- 2. Retarget M-Pesa C2B receipts at microfinance lending
ALTER TABLE public.mpesa_c2b_transactions
  ADD COLUMN IF NOT EXISTS matched_loan_id uuid REFERENCES public.mf_loans(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS matched_client_id uuid REFERENCES public.mf_clients(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS matched_repayment_id uuid REFERENCES public.mf_repayments(id) ON DELETE SET NULL;

ALTER TABLE public.mpesa_c2b_transactions
  DROP COLUMN IF EXISTS matched_pos_transaction_id;

CREATE INDEX IF NOT EXISTS idx_mpesa_c2b_matched_loan
  ON public.mpesa_c2b_transactions (matched_loan_id);
CREATE INDEX IF NOT EXISTS idx_mpesa_c2b_unreconciled
  ON public.mpesa_c2b_transactions (organization_id, is_reconciled);