
-- 1. due_day_basis on remittance schedules
ALTER TABLE public.localization_pack_remittance_schedules
  ADD COLUMN IF NOT EXISTS due_day_basis text NOT NULL DEFAULT 'calendar_day';

ALTER TABLE public.localization_pack_remittance_schedules
  DROP CONSTRAINT IF EXISTS localization_pack_remittance_schedules_due_day_basis_check;

ALTER TABLE public.localization_pack_remittance_schedules
  ADD CONSTRAINT localization_pack_remittance_schedules_due_day_basis_check
  CHECK (due_day_basis IN ('calendar_day', 'working_day'));

-- 2. pack_version_id on all child template tables
ALTER TABLE public.localization_pack_account_templates
  ADD COLUMN IF NOT EXISTS pack_version_id uuid
  REFERENCES public.pack_versions(id) ON DELETE RESTRICT;

ALTER TABLE public.localization_pack_certificate_templates
  ADD COLUMN IF NOT EXISTS pack_version_id uuid
  REFERENCES public.pack_versions(id) ON DELETE RESTRICT;

ALTER TABLE public.localization_pack_payroll_templates
  ADD COLUMN IF NOT EXISTS pack_version_id uuid
  REFERENCES public.pack_versions(id) ON DELETE RESTRICT;

ALTER TABLE public.localization_pack_remittance_schedules
  ADD COLUMN IF NOT EXISTS pack_version_id uuid
  REFERENCES public.pack_versions(id) ON DELETE RESTRICT;

ALTER TABLE public.localization_pack_return_templates
  ADD COLUMN IF NOT EXISTS pack_version_id uuid
  REFERENCES public.pack_versions(id) ON DELETE RESTRICT;

ALTER TABLE public.localization_pack_tax_templates
  ADD COLUMN IF NOT EXISTS pack_version_id uuid
  REFERENCES public.pack_versions(id) ON DELETE RESTRICT;

-- 3. Backfill pack_version_id from the latest published pack_versions row per pack
WITH latest_version AS (
  SELECT DISTINCT ON (pack_id) pack_id, id AS version_id
  FROM public.pack_versions
  WHERE status = 'published'
  ORDER BY pack_id, published_at DESC NULLS LAST, created_at DESC
)
UPDATE public.localization_pack_account_templates t
SET pack_version_id = lv.version_id
FROM latest_version lv
WHERE t.pack_id = lv.pack_id AND t.pack_version_id IS NULL;

WITH latest_version AS (
  SELECT DISTINCT ON (pack_id) pack_id, id AS version_id
  FROM public.pack_versions
  WHERE status = 'published'
  ORDER BY pack_id, published_at DESC NULLS LAST, created_at DESC
)
UPDATE public.localization_pack_certificate_templates t
SET pack_version_id = lv.version_id
FROM latest_version lv
WHERE t.pack_id = lv.pack_id AND t.pack_version_id IS NULL;

WITH latest_version AS (
  SELECT DISTINCT ON (pack_id) pack_id, id AS version_id
  FROM public.pack_versions
  WHERE status = 'published'
  ORDER BY pack_id, published_at DESC NULLS LAST, created_at DESC
)
UPDATE public.localization_pack_payroll_templates t
SET pack_version_id = lv.version_id
FROM latest_version lv
WHERE t.pack_id = lv.pack_id AND t.pack_version_id IS NULL;

WITH latest_version AS (
  SELECT DISTINCT ON (pack_id) pack_id, id AS version_id
  FROM public.pack_versions
  WHERE status = 'published'
  ORDER BY pack_id, published_at DESC NULLS LAST, created_at DESC
)
UPDATE public.localization_pack_remittance_schedules t
SET pack_version_id = lv.version_id
FROM latest_version lv
WHERE t.pack_id = lv.pack_id AND t.pack_version_id IS NULL;

WITH latest_version AS (
  SELECT DISTINCT ON (pack_id) pack_id, id AS version_id
  FROM public.pack_versions
  WHERE status = 'published'
  ORDER BY pack_id, published_at DESC NULLS LAST, created_at DESC
)
UPDATE public.localization_pack_return_templates t
SET pack_version_id = lv.version_id
FROM latest_version lv
WHERE t.pack_id = lv.pack_id AND t.pack_version_id IS NULL;

WITH latest_version AS (
  SELECT DISTINCT ON (pack_id) pack_id, id AS version_id
  FROM public.pack_versions
  WHERE status = 'published'
  ORDER BY pack_id, published_at DESC NULLS LAST, created_at DESC
)
UPDATE public.localization_pack_tax_templates t
SET pack_version_id = lv.version_id
FROM latest_version lv
WHERE t.pack_id = lv.pack_id AND t.pack_version_id IS NULL;

-- 4. Indexes
CREATE INDEX IF NOT EXISTS idx_loc_pack_account_templates_pack_ver
  ON public.localization_pack_account_templates(pack_id, pack_version_id);
CREATE INDEX IF NOT EXISTS idx_loc_pack_certificate_templates_pack_ver
  ON public.localization_pack_certificate_templates(pack_id, pack_version_id);
CREATE INDEX IF NOT EXISTS idx_loc_pack_payroll_templates_pack_ver
  ON public.localization_pack_payroll_templates(pack_id, pack_version_id);
CREATE INDEX IF NOT EXISTS idx_loc_pack_remittance_schedules_pack_ver
  ON public.localization_pack_remittance_schedules(pack_id, pack_version_id);
CREATE INDEX IF NOT EXISTS idx_loc_pack_return_templates_pack_ver
  ON public.localization_pack_return_templates(pack_id, pack_version_id);
CREATE INDEX IF NOT EXISTS idx_loc_pack_tax_templates_pack_ver
  ON public.localization_pack_tax_templates(pack_id, pack_version_id);
