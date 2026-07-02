
-- Stage A.2 + Stage B: add dedup index for payroll_statutory_rules and
-- backfill rules for tenants whose pack install never seeded them
-- (broken organization_apps gate in install-localization-pack).

-- 1) Idempotent dedup index used by ON CONFLICT in the edge function.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_statutory_rules_dedup_idx
  ON public.payroll_statutory_rules (
    organization_id,
    country_code,
    rule_type,
    rule_name,
    effective_from
  );

-- 2) Backfill: for every installed pack, copy missing payroll templates
-- into payroll_statutory_rules at the org level. Safe to re-run.
INSERT INTO public.payroll_statutory_rules (
  organization_id,
  country_code,
  rule_type,
  rule_name,
  parameters,
  sort_order,
  is_active
)
SELECT
  ilp.organization_id,
  lp.country_code,
  t.rule_type,
  t.rule_name,
  t.parameters,
  t.sort_order,
  true
FROM public.installed_localization_packs ilp
JOIN public.localization_packs lp ON lp.id = ilp.pack_id
JOIN public.localization_pack_payroll_templates t ON t.pack_id = ilp.pack_id
ON CONFLICT (organization_id, country_code, rule_type, rule_name, effective_from)
DO NOTHING;
