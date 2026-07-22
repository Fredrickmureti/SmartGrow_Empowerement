
CREATE TABLE IF NOT EXISTS public.reset_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID,
  initiated_by UUID,
  mode TEXT NOT NULL,
  categories TEXT[],
  stage TEXT NOT NULL DEFAULT 'started',
  ok BOOLEAN,
  error TEXT,
  error_code TEXT,
  error_hint TEXT,
  counts JSONB,
  storage_result JSONB,
  trigger_source TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reset_runs_org_started ON public.reset_runs (organization_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_reset_runs_mode ON public.reset_runs (mode);

GRANT SELECT ON public.reset_runs TO authenticated;
GRANT ALL ON public.reset_runs TO service_role;

ALTER TABLE public.reset_runs ENABLE ROW LEVEL SECURITY;

-- Members of the org may view its reset runs
CREATE POLICY "Org members can view their reset runs"
ON public.reset_runs
FOR SELECT
TO authenticated
USING (
  organization_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
      AND uba.organization_id = reset_runs.organization_id
  )
);

-- Platform admins may view every reset run (incl. gc_orphans with null org)
CREATE POLICY "Platform admins can view all reset runs"
ON public.reset_runs
FOR SELECT
TO authenticated
USING (public.is_platform_admin(auth.uid()));
