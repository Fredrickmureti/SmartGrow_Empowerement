
-- Migration system tables

-- Migration sessions - tracks each migration attempt
CREATE TABLE public.migration_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_progress', 'validating', 'completed', 'failed', 'rolled_back')),
  cutover_date DATE,
  source_system TEXT,
  notes TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.migration_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage migration sessions for their org"
  ON public.migration_sessions
  FOR ALL
  TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
  ))
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
  ));

-- Migration steps - tracks each step within a session
CREATE TABLE public.migration_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.migration_sessions(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL CHECK (step_key IN ('config', 'accounts', 'contacts', 'products', 'trial_balance', 'open_ar', 'open_ap', 'bank_balances', 'inventory', 'validation', 'finalization')),
  step_order INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped', 'failed')),
  record_count INT DEFAULT 0,
  error_count INT DEFAULT 0,
  error_log JSONB DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, step_key)
);

ALTER TABLE public.migration_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage migration steps via session"
  ON public.migration_steps
  FOR ALL
  TO authenticated
  USING (session_id IN (
    SELECT id FROM public.migration_sessions WHERE organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  ))
  WITH CHECK (session_id IN (
    SELECT id FROM public.migration_sessions WHERE organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  ));

-- Migration batches - idempotent batch tracking
CREATE TABLE public.migration_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.migration_sessions(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  batch_hash TEXT NOT NULL,
  source_file_name TEXT,
  records_total INT DEFAULT 0,
  records_imported INT DEFAULT 0,
  records_failed INT DEFAULT 0,
  error_details JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, batch_hash)
);

ALTER TABLE public.migration_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage migration batches via session"
  ON public.migration_batches
  FOR ALL
  TO authenticated
  USING (session_id IN (
    SELECT id FROM public.migration_sessions WHERE organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  ))
  WITH CHECK (session_id IN (
    SELECT id FROM public.migration_sessions WHERE organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  ));

-- Indexes
CREATE INDEX idx_migration_sessions_org ON public.migration_sessions(organization_id);
CREATE INDEX idx_migration_steps_session ON public.migration_steps(session_id);
CREATE INDEX idx_migration_batches_session ON public.migration_batches(session_id);
CREATE INDEX idx_migration_batches_hash ON public.migration_batches(session_id, batch_hash);
