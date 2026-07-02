-- ============================================================================
-- Q-1: accounting_integrity_reports table + RLS
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.accounting_integrity_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  ran_at timestamptz NOT NULL DEFAULT now(),
  balance_drifts_count int NOT NULL DEFAULT 0,
  ar_drift numeric NOT NULL DEFAULT 0,
  ap_drift numeric NOT NULL DEFAULT 0,
  total_abs_drift numeric NOT NULL DEFAULT 0,
  has_drift boolean NOT NULL DEFAULT false,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_air_org_ran ON public.accounting_integrity_reports (organization_id, ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_air_has_drift ON public.accounting_integrity_reports (has_drift) WHERE has_drift = true;

ALTER TABLE public.accounting_integrity_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view integrity reports"
  ON public.accounting_integrity_reports
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = accounting_integrity_reports.organization_id
        AND COALESCE(ur.is_active, true)
    )
  );

-- No public INSERT/UPDATE/DELETE policies — only service-role (edge function) writes.

-- ============================================================================
-- Q-1: Schedule nightly drift check at 02:00 UTC
-- Calls the check-accounting-integrity edge function via pg_net.
-- ============================================================================
DO $$
BEGIN
  PERFORM cron.unschedule('check-accounting-integrity-nightly');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'check-accounting-integrity-nightly',
  '0 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/check-accounting-integrity',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc'
    ),
    body := jsonb_build_object('triggered_at', now()::text)
  );
  $$
);