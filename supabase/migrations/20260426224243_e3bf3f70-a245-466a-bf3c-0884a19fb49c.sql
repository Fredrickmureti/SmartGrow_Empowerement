-- 1. Add per-company receipt settings JSONB column.
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS receipt_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.businesses.receipt_settings IS
  'Per-company receipt formatting (paper size, template, typography, field visibility). Replaces the workspace-scoped organization_settings.receipt_settings, which could not differ between companies in the same workspace.';

-- 2. Backfill existing workspace-level receipt settings into the primary
--    company of each workspace. Only fills companies that don't already have
--    receipt_settings (so re-running is a no-op).
WITH workspace_settings AS (
  SELECT organization_id, setting_value
  FROM public.organization_settings
  WHERE setting_key = 'receipt_settings'
),
primary_companies AS (
  -- Pick the first company per workspace deterministically. We don't have a
  -- "primary company" flag on businesses itself; user_business_access has
  -- is_primary but per-user. Workspace-wide primary = oldest active company.
  SELECT DISTINCT ON (organization_id)
    id, organization_id
  FROM public.businesses
  WHERE is_active = true
  ORDER BY organization_id, created_at ASC
)
UPDATE public.businesses b
SET receipt_settings = ws.setting_value
FROM workspace_settings ws
JOIN primary_companies pc ON pc.organization_id = ws.organization_id
WHERE b.id = pc.id
  AND (b.receipt_settings IS NULL OR b.receipt_settings = '{}'::jsonb);