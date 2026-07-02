-- H2: Report saved views / favorites / recent reports
CREATE TABLE IF NOT EXISTS public.report_saved_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL,          -- e.g., 'financial', 'trial-balance', 'cash-flow'
  view_name TEXT NOT NULL,
  filters_json JSONB NOT NULL DEFAULT '{}',
  is_favorite BOOLEAN NOT NULL DEFAULT false,
  is_default BOOLEAN NOT NULL DEFAULT false,
  last_accessed_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_report_saved_views_org_user 
  ON public.report_saved_views(organization_id, user_id);

CREATE INDEX IF NOT EXISTS idx_report_saved_views_favorites 
  ON public.report_saved_views(organization_id, user_id, is_favorite) 
  WHERE is_favorite = true;

-- RLS
ALTER TABLE public.report_saved_views ENABLE ROW LEVEL SECURITY;

-- Users can manage their own saved views
CREATE POLICY "Users can view own report views"
  ON public.report_saved_views FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can create own report views"
  ON public.report_saved_views FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own report views"
  ON public.report_saved_views FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete own report views"
  ON public.report_saved_views FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- Recent reports tracking table
CREATE TABLE IF NOT EXISTS public.report_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL,
  report_path TEXT NOT NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_access_log_user 
  ON public.report_access_log(organization_id, user_id, accessed_at DESC);

ALTER TABLE public.report_access_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own report access log"
  ON public.report_access_log FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert own report access log"
  ON public.report_access_log FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());