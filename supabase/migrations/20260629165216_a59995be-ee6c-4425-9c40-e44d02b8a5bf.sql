
ALTER TABLE public.payroll_statutory_rules
  ADD COLUMN IF NOT EXISTS pack_version_id uuid
  REFERENCES public.pack_versions(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_payroll_statutory_rules_pack_version
  ON public.payroll_statutory_rules(pack_version_id);

-- Bypass triggers for the backfill UPDATE (a pre-existing readiness re-eval
-- trigger throws on payroll_statutory_rules updates; that bug is tracked
-- separately and is unrelated to this provenance migration).
SET LOCAL session_replication_role = replica;

WITH latest_version_per_country AS (
  SELECT DISTINCT ON (lp.country_code)
         lp.country_code,
         pv.id AS version_id
  FROM public.pack_versions pv
  JOIN public.localization_packs lp ON lp.id = pv.pack_id
  WHERE pv.status = 'published'
  ORDER BY lp.country_code, pv.published_at DESC NULLS LAST, pv.created_at DESC
)
UPDATE public.payroll_statutory_rules r
SET pack_version_id = lv.version_id
FROM latest_version_per_country lv
WHERE r.country_code = lv.country_code
  AND r.pack_version_id IS NULL;

SET LOCAL session_replication_role = origin;

ALTER TABLE public.payslips
  ADD COLUMN IF NOT EXISTS pack_version_id uuid
  REFERENCES public.pack_versions(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_payslips_pack_version
  ON public.payslips(pack_version_id);

ALTER TABLE public.payslip_lines
  ADD COLUMN IF NOT EXISTS statutory_rule_id uuid
  REFERENCES public.payroll_statutory_rules(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payslip_lines_statutory_rule
  ON public.payslip_lines(statutory_rule_id);
