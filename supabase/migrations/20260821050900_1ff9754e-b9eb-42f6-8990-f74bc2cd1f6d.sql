-- Phase 4: scope-key the AI insights cache and usage logs

ALTER TABLE public.ai_insights_cache
  ADD COLUMN IF NOT EXISTS branch_id uuid,
  ADD COLUMN IF NOT EXISTS app_key text;

DROP INDEX IF EXISTS public.ai_insights_cache_org_user_type_biz_idx;

CREATE UNIQUE INDEX IF NOT EXISTS ai_insights_cache_scope_idx
  ON public.ai_insights_cache (
    organization_id,
    user_id,
    insight_type,
    COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(app_key, '')
  );

ALTER TABLE public.ai_usage_logs
  ADD COLUMN IF NOT EXISTS organization_id uuid,
  ADD COLUMN IF NOT EXISTS business_id uuid,
  ADD COLUMN IF NOT EXISTS branch_id uuid,
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS app_key text;

CREATE INDEX IF NOT EXISTS ai_usage_logs_scope_idx
  ON public.ai_usage_logs (organization_id, business_id, branch_id, created_at DESC);

ALTER TABLE public.ai_advisory_usage
  ADD COLUMN IF NOT EXISTS app_key text;
