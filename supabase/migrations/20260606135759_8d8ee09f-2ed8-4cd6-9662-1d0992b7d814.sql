-- 1) Widen the status check to include the new self-service states.
ALTER TABLE public.employee_loans
  DROP CONSTRAINT IF EXISTS employee_loans_status_check;

ALTER TABLE public.employee_loans
  ADD CONSTRAINT employee_loans_status_check
  CHECK (status = ANY (ARRAY[
    'requested'::text,
    'pending_approval'::text,
    'rejected'::text,
    'draft'::text,
    'active'::text,
    'completed'::text,
    'cancelled'::text,
    'suspended'::text
  ]));

-- 2) New tracking columns.
ALTER TABLE public.employee_loans
  ADD COLUMN IF NOT EXISTS requested_by uuid,
  ADD COLUMN IF NOT EXISTS requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS rejected_by uuid,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz;

-- 3) RLS: let employees create loan requests for themselves in 'requested' state.
DROP POLICY IF EXISTS employee_loans_insert_self_request ON public.employee_loans;
CREATE POLICY employee_loans_insert_self_request
  ON public.employee_loans
  FOR INSERT
  TO authenticated
  WITH CHECK (
    status = 'requested'
    AND employee_id IN (
      SELECT id FROM public.employees WHERE user_id = auth.uid()
    )
    AND requested_by = auth.uid()
  );

-- 4) Allow employees to cancel their OWN requests while still in 'requested' state.
DROP POLICY IF EXISTS employee_loans_update_self_request ON public.employee_loans;
CREATE POLICY employee_loans_update_self_request
  ON public.employee_loans
  FOR UPDATE
  TO authenticated
  USING (
    status = 'requested'
    AND employee_id IN (
      SELECT id FROM public.employees WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    status IN ('requested','cancelled')
    AND employee_id IN (
      SELECT id FROM public.employees WHERE user_id = auth.uid()
    )
  );

COMMENT ON COLUMN public.employee_loans.requested_by IS
  'The auth user (employee) who submitted the loan request via self-service. NULL for HR-initiated loans.';
COMMENT ON COLUMN public.employee_loans.rejection_reason IS
  'Reason supplied by the approver when status transitions to rejected.';