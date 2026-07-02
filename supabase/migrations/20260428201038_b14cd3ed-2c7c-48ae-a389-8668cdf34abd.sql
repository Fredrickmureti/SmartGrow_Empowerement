ALTER TABLE public.onboarding_attempts
  ADD COLUMN IF NOT EXISTS diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.onboarding_attempts.diagnostics IS
  'Per-attempt telemetry collected by the workspace-provisioning flow: readiness_ms (time from RPC return → currentBusiness ready), tab_count (active tabs at start), readiness_state (ready|timed_out), and any other instrumentation fields added over time.';