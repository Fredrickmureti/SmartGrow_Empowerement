-- Slice A3 — correction-run idempotency ledger.
-- Records every signed bump the payroll engine applies to mutable downstream
-- state (garnishment.total_paid, expenses.reimbursed_*) during a correction
-- run, so re-running compute is idempotent and the parent-run delta is
-- recoverable for audit. Engine wiring follows in a separate change behind
-- env flag PAYROLL_CORRECTION_ADJUSTERS_V2.

CREATE TABLE public.payroll_correction_adjustments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id     uuid NOT NULL,
  payroll_run_id  uuid NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  parent_run_id   uuid NOT NULL REFERENCES public.payroll_runs(id) ON DELETE RESTRICT,
  employee_id     uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  source_kind     text NOT NULL CHECK (source_kind IN ('garnishment','reimbursement')),
  source_id       uuid NOT NULL,
  signed_amount   numeric(18,4) NOT NULL,
  applied_at      timestamptz NOT NULL DEFAULT now(),
  applied_by      uuid,
  notes           text,
  -- One ledger row per (run, source) — guarantees idempotency on re-compute.
  CONSTRAINT payroll_correction_adjustments_unique_per_run
    UNIQUE (payroll_run_id, source_kind, source_id)
);

CREATE INDEX payroll_correction_adjustments_run_idx
  ON public.payroll_correction_adjustments (payroll_run_id);
CREATE INDEX payroll_correction_adjustments_parent_idx
  ON public.payroll_correction_adjustments (parent_run_id);
CREATE INDEX payroll_correction_adjustments_source_idx
  ON public.payroll_correction_adjustments (source_kind, source_id);

-- Grants: authenticated users get read-only via RLS; writes go through service_role
-- (edge function). No anon access — payroll adjustments are sensitive finance data.
GRANT SELECT ON public.payroll_correction_adjustments TO authenticated;
GRANT ALL    ON public.payroll_correction_adjustments TO service_role;

ALTER TABLE public.payroll_correction_adjustments ENABLE ROW LEVEL SECURITY;

-- Mirror employee_garnishments_hr_write scope for reads: HR/finance roles only.
CREATE POLICY payroll_correction_adjustments_finance_read
  ON public.payroll_correction_adjustments
  FOR SELECT
  TO authenticated
  USING (
    organization_id IN (
      SELECT uba.organization_id FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
    )
    AND (
      public.has_role(auth.uid(), 'admin')
      OR public.has_role(auth.uid(), 'owner')
      OR public.has_role(auth.uid(), 'accountant')
      OR public.has_role(auth.uid(), 'super_admin')
    )
  );

-- No INSERT/UPDATE/DELETE policies — service_role bypasses RLS, all other
-- writes are denied. The ledger is engine-managed and immutable from the API.

COMMENT ON TABLE public.payroll_correction_adjustments IS
  'Slice A3 idempotency ledger: signed bumps applied to employee_garnishments.total_paid '
  'and expenses.reimbursed_* during correction payroll runs. Engine writes are gated '
  'behind env PAYROLL_CORRECTION_ADJUSTERS_V2.';
COMMENT ON COLUMN public.payroll_correction_adjustments.signed_amount IS
  'Positive when correction increases the downstream balance, negative when it decreases. '
  'Sum over (parent_run_id, source) reconstructs the net adjustment chain.';
COMMENT ON COLUMN public.payroll_correction_adjustments.source_kind IS
  'Discriminator for source_id: ''garnishment'' -> employee_garnishments.id, '
  '''reimbursement'' -> expenses.id.';