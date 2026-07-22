
-- Phase 4 · Concurrency guard: only one running regular job per period.
-- Two tabs firing Run Payroll for the same period would generate different
-- idempotency keys and both slip past the per-key unique index. This partial
-- unique index stops the second one at insert time.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payroll_run_jobs_running_regular_period
  ON public.payroll_run_jobs (organization_id, pay_period_start, pay_period_end)
  WHERE status = 'running' AND run_type = 'regular';
