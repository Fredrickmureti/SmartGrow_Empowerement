
-- ─── A1: Status view ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_payroll_statutory_rule_status
WITH (security_invoker = true) AS
WITH installed AS (
  SELECT DISTINCT ON (organization_id, business_id, pack_id)
    organization_id, business_id, pack_id, pack_version, installed_at
  FROM public.installed_localization_packs
  ORDER BY organization_id, business_id, pack_id, installed_at DESC
),
latest_conflict AS (
  SELECT DISTINCT ON (rule_id)
    rule_id, status, from_version, to_version, resolution_notes, resolved_at, created_at
  FROM public.pack_rule_conflicts
  WHERE rule_table = 'payroll_statutory_rules'
  ORDER BY rule_id, created_at DESC
),
pending_proposal AS (
  SELECT
    p.id AS proposal_id,
    p.organization_id,
    p.business_id,
    p.pack_id,
    p.from_version,
    p.to_version,
    p.created_at,
    (item->>'rule_code') AS rule_code
  FROM public.pack_upgrade_proposals p,
       LATERAL jsonb_array_elements(
         CASE
           WHEN jsonb_typeof(p.diff->'payroll_statutory_rules') = 'array'
             THEN p.diff->'payroll_statutory_rules'
           ELSE '[]'::jsonb
         END
       ) AS item
  WHERE p.status = 'pending'
),
last_audit AS (
  SELECT entity_id, max(created_at) AS last_audit_at
  FROM public.pack_audit_log
  WHERE entity_table = 'payroll_statutory_rules'
  GROUP BY entity_id
)
SELECT
  r.id                                    AS rule_id,
  r.organization_id,
  r.business_id,
  r.country_code,
  r.rule_code,
  r.rule_type,
  r.rule_name,
  r.computation_method,
  r.parameters,
  r.effective_from,
  r.effective_to,
  r.superseded_by,
  r.is_active,
  r.sort_order,
  r.is_tenant_override,
  r.base_pack_template_id,
  r.base_pack_version,
  r.override_reason,
  r.override_version,
  r.pack_version_id,
  r.legacy_unvalidated,
  i.pack_id                               AS pinned_pack_id,
  i.pack_version                          AS pinned_pack_version,
  i.installed_at                          AS pinned_installed_at,
  lp.name                                 AS pinned_pack_name,
  c.status                                AS conflict_status,
  c.from_version                          AS conflict_from_version,
  c.to_version                            AS conflict_to_version,
  c.resolution_notes                      AS conflict_resolution_notes,
  c.resolved_at                           AS conflict_resolved_at,
  pp.proposal_id                          AS pending_proposal_id,
  pp.to_version                           AS pending_to_version,
  pp.from_version                         AS pending_from_version,
  la.last_audit_at,
  CASE
    WHEN r.is_tenant_override IS TRUE                                THEN 'tenant_override'
    WHEN c.status IN ('conflict','rollback_blocked')                 THEN 'conflict'
    WHEN pp.proposal_id IS NOT NULL                                  THEN 'pending_upgrade'
    WHEN r.base_pack_template_id IS NULL AND r.pack_version_id IS NULL THEN 'tenant_authored'
    ELSE 'pack_clean'
  END                                     AS divergence
FROM public.payroll_statutory_rules r
LEFT JOIN installed i
  ON i.organization_id = r.organization_id
 AND (i.business_id IS NOT DISTINCT FROM r.business_id OR r.business_id IS NULL)
 AND i.pack_id = (
   SELECT lp2.id FROM public.localization_packs lp2
   WHERE lp2.country_code = r.country_code
   ORDER BY lp2.is_published DESC, lp2.created_at DESC
   LIMIT 1
 )
LEFT JOIN public.localization_packs lp ON lp.id = i.pack_id
LEFT JOIN latest_conflict c ON c.rule_id = r.id
LEFT JOIN pending_proposal pp
  ON pp.organization_id = r.organization_id
 AND (pp.business_id IS NOT DISTINCT FROM r.business_id)
 AND pp.rule_code = r.rule_code
LEFT JOIN last_audit la ON la.entity_id = r.id;

GRANT SELECT ON public.v_payroll_statutory_rule_status TO authenticated;

-- ─── A2: Consumers view ──────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_payroll_statutory_rule_consumers
WITH (security_invoker = true) AS
SELECT
  r.id AS rule_id,
  r.organization_id,
  r.business_id,
  r.country_code,
  r.rule_code,
  COALESCE((
    SELECT count(*)::int FROM public.payslip_lines pl
    WHERE pl.rule_version_id = r.id
      AND pl.created_at >= (now() - interval '12 months')
  ), 0) AS payslip_line_count_12m,
  COALESCE((
    SELECT count(*)::int FROM public.payslip_lines pl
    WHERE pl.rule_version_id = r.id
  ), 0) AS payslip_line_count_total,
  COALESCE((
    SELECT array_agg(DISTINCT par.role_key)
    FROM public.pack_account_roles par
    JOIN public.installed_localization_packs ilp
      ON ilp.pack_id = par.pack_id
     AND ilp.organization_id = r.organization_id
    WHERE par.role_key ILIKE '%' || lower(r.rule_code) || '%'
  ), ARRAY[]::text[]) AS gl_account_role_keys,
  COALESCE((
    SELECT array_agg(DISTINCT rs.authority_name || ' (' || rs.frequency || ')')
    FROM public.localization_pack_remittance_schedules rs
    JOIN public.installed_localization_packs ilp
      ON ilp.pack_id = rs.pack_id
     AND ilp.organization_id = r.organization_id
    WHERE rs.rule_code = r.rule_code
  ), ARRAY[]::text[]) AS remittance_schedules,
  COALESCE((
    SELECT count(*)::int FROM public.payroll_salary_rules sr
    WHERE sr.statutory_rule_id = r.id
  ), 0) AS salary_rule_count
FROM public.payroll_statutory_rules r;

GRANT SELECT ON public.v_payroll_statutory_rule_consumers TO authenticated;

-- ─── A3: Timeline view ───────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_payroll_statutory_rule_timeline
WITH (security_invoker = true) AS
SELECT
  r.organization_id,
  r.business_id,
  r.country_code,
  r.rule_code,
  r.id                AS rule_id,
  r.rule_name,
  r.effective_from,
  r.effective_to,
  r.superseded_by,
  r.is_active,
  r.is_tenant_override,
  (
    r.is_active
    AND r.effective_from <= current_date
    AND (r.effective_to IS NULL OR r.effective_to >= current_date)
    AND r.superseded_by IS NULL
  ) AS is_current,
  (r.effective_from > current_date) AS is_scheduled,
  (
    r.superseded_by IS NOT NULL
    OR (r.effective_to IS NOT NULL AND r.effective_to < current_date)
  ) AS is_superseded
FROM public.payroll_statutory_rules r;

GRANT SELECT ON public.v_payroll_statutory_rule_timeline TO authenticated;

COMMENT ON VIEW public.v_payroll_statutory_rule_status IS
  'Statutory rule rows joined with their installed pack pin, latest pack_rule_conflict, and any pending pack_upgrade_proposal. Derived `divergence` column drives the workspace provenance badges. SECURITY INVOKER — RLS on underlying tables applies.';
COMMENT ON VIEW public.v_payroll_statutory_rule_consumers IS
  'Per-rule downstream impact: payslip line counts, GL account role keys, remittance schedules, and salary-rule references. Read-only, SECURITY INVOKER.';
COMMENT ON VIEW public.v_payroll_statutory_rule_timeline IS
  'Per-rule-code effective-date timeline (past / current / scheduled / superseded). Read-only, SECURITY INVOKER.';
