ALTER TYPE public.expense_status ADD VALUE IF NOT EXISTS 'draft';
ALTER TYPE public.expense_status ADD VALUE IF NOT EXISTS 'submitted';
ALTER TYPE public.expense_status ADD VALUE IF NOT EXISTS 'voided';

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS paid_by text NOT NULL DEFAULT 'company',
  ADD COLUMN IF NOT EXISTS approval_request_id uuid REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS base_amount numeric,
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by uuid,
  ADD COLUMN IF NOT EXISTS rejected_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_paid_by_check'
  ) THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_paid_by_check
      CHECK (paid_by IN ('company','employee','company_card'));
  END IF;
END $$;

DROP INDEX IF EXISTS public.idx_bills_source_expense;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_source_expense_unique
  ON public.bills (source_expense_id)
  WHERE source_expense_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_approval_request
  ON public.expenses (approval_request_id)
  WHERE approval_request_id IS NOT NULL;

INSERT INTO public.governance_action_registry
  (action_key, module, subject_table, subject_mode, label, description, severity_default, is_active, requires_approval_always)
VALUES
  ('expense.submit', 'expenses', 'expenses', 'from_entity', 'Submit expense for approval',
   'Submit a captured expense into the approval workflow.', 'low', true, false),
  ('expense.void', 'expenses', 'expenses', 'from_entity', 'Void a posted expense',
   'Reverse the accounting entry of an approved or paid expense.', 'high', true, false)
ON CONFLICT (action_key) DO NOTHING;