
CREATE TABLE IF NOT EXISTS public.finance_integrity_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  issue_code text NOT NULL,
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','error','critical')),
  source_type text NOT NULL,
  source_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolved_note text
);

CREATE INDEX IF NOT EXISTS idx_finance_integrity_open
  ON public.finance_integrity_issues (organization_id, resolved_at)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_finance_integrity_source
  ON public.finance_integrity_issues (source_type, source_id);

ALTER TABLE public.finance_integrity_issues ENABLE ROW LEVEL SECURITY;

-- Read: any member of the organization
DROP POLICY IF EXISTS "Org members can read integrity issues" ON public.finance_integrity_issues;
CREATE POLICY "Org members can read integrity issues"
  ON public.finance_integrity_issues
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = finance_integrity_issues.organization_id
    )
  );

-- Update (mark resolved): admins only
DROP POLICY IF EXISTS "Admins can resolve integrity issues" ON public.finance_integrity_issues;
CREATE POLICY "Admins can resolve integrity issues"
  ON public.finance_integrity_issues
  FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Inserts only by service_role; no INSERT policy means authenticated cannot insert via RLS.
