
-- Phase 2: payroll_run_jobs — durable control row for compute-payroll invocations.
-- Purpose:
--   1. Server-side idempotency: the same idempotency_key can be safely retried
--      after a transport failure without creating duplicate payslips.
--   2. Execution visibility: the UI can subscribe to job status via Realtime
--      instead of guessing from an HTTP status that may never arrive.

CREATE TABLE IF NOT EXISTS public.payroll_run_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL,
  business_id UUID NULL,
  requested_by UUID NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed')),
  pay_period_start DATE NOT NULL,
  pay_period_end DATE NOT NULL,
  run_type TEXT NOT NULL DEFAULT 'regular',
  employee_count INTEGER NOT NULL DEFAULT 0,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  payroll_run_id UUID NULL,
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique across org — this is what makes retries safe. A retry with the same
-- key returns the existing row instead of executing a second time.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payroll_run_jobs_org_key
  ON public.payroll_run_jobs (organization_id, idempotency_key);

CREATE INDEX IF NOT EXISTS ix_payroll_run_jobs_org_status_created
  ON public.payroll_run_jobs (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_payroll_run_jobs_run
  ON public.payroll_run_jobs (payroll_run_id)
  WHERE payroll_run_id IS NOT NULL;

GRANT SELECT ON public.payroll_run_jobs TO authenticated;
GRANT ALL ON public.payroll_run_jobs TO service_role;

ALTER TABLE public.payroll_run_jobs ENABLE ROW LEVEL SECURITY;

-- Reads are scoped to the user's active org (same pattern as payroll_runs).
-- Writes go exclusively through the compute-payroll edge function under
-- service_role — no direct client insert/update.
CREATE POLICY "payroll_run_jobs_read_org"
  ON public.payroll_run_jobs
  FOR SELECT
  TO authenticated
  USING (
    organization_id IN (
      SELECT uba.organization_id
      FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
    )
  );

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_run_jobs_updated_at ON public.payroll_run_jobs;
CREATE TRIGGER trg_payroll_run_jobs_updated_at
BEFORE UPDATE ON public.payroll_run_jobs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Realtime: the UI subscribes to status changes so a transport drop
-- (which no longer trusts the HTTP response) can still show "running" or
-- "succeeded" as compute-payroll finishes on the server.
ALTER PUBLICATION supabase_realtime ADD TABLE public.payroll_run_jobs;
ALTER TABLE public.payroll_run_jobs REPLICA IDENTITY FULL;
