-- Hardware command audit log
-- Records every command dispatched via HardwareClient.exec so support can
-- answer "who printed which receipt on which device at what time".

CREATE TABLE IF NOT EXISTS public.hardware_exec_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  business_id UUID,
  actor_user_id UUID,
  role TEXT NOT NULL,
  op TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  duration_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  idempotency_key TEXT,
  runtime_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hardware_exec_log_org_created
  ON public.hardware_exec_log (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hardware_exec_log_role_created
  ON public.hardware_exec_log (org_id, role, created_at DESC);

ALTER TABLE public.hardware_exec_log ENABLE ROW LEVEL SECURITY;

-- View: any member of the org may read their own org's log.
-- user_roles is the canonical org-membership signal in this project.
CREATE POLICY "hardware_exec_log_select_org_members"
ON public.hardware_exec_log
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = hardware_exec_log.org_id
  )
);

-- Insert: any authenticated member of the org may append a row for their org.
-- The actor_user_id must match auth.uid() to prevent log-forging.
CREATE POLICY "hardware_exec_log_insert_org_members"
ON public.hardware_exec_log
FOR INSERT
TO authenticated
WITH CHECK (
  (actor_user_id IS NULL OR actor_user_id = auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = hardware_exec_log.org_id
  )
);