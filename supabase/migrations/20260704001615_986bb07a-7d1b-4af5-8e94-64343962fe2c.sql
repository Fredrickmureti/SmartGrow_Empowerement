
-- ============================================================================
-- Phase 3 — Payroll GL upgrade diff (read-only classifier)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.payroll_gl_upgrade_diff(
  _org_id uuid,
  _business_id uuid DEFAULT NULL
)
RETURNS TABLE (
  status text,                    -- new_key | deprecated_key | stale_pack_version | changed_recommendation
  setting_key text,
  label text,
  rule_code text,
  kind text,
  required_account_type text,
  current_account_id uuid,
  current_account_code text,
  current_account_name text,
  current_source text,
  current_pack_version text,
  installed_pack_version text,
  recommended_account_id uuid,
  recommended_account_code text,
  recommended_account_name text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  RETURN QUERY
  WITH needed AS (
    SELECT r.setting_key, r.label, r.rule_code, r.kind,
           r.required_account_type,
           r.is_mapped, r.suggested_account_id
    FROM public.payroll_gl_readiness(_org_id, _business_id) r
  ),
  installed AS (
    -- Pick the newest installed pack version for the org (any country pack)
    SELECT DISTINCT ON (ilp.organization_id)
           ilp.pack_id, ilp.pack_version
    FROM public.installed_localization_packs ilp
    WHERE ilp.organization_id = _org_id
      AND ilp.status = 'active'
    ORDER BY ilp.organization_id, ilp.installed_at DESC
  ),
  existing AS (
    SELECT das.setting_key, das.account_id, das.source,
           das.origin_pack_id, das.origin_pack_version,
           das.override_reason,
           a.code AS account_code, a.name AS account_name
    FROM public.default_account_settings das
    LEFT JOIN public.accounts a ON a.id = das.account_id
    WHERE das.organization_id = _org_id
      AND (_business_id IS NULL OR das.business_id = _business_id)
      -- Only payroll-scope keys — heuristic: readiness covers them
      AND das.setting_key IN (SELECT setting_key FROM public.payroll_gl_readiness(_org_id, _business_id))
  )
  -- 1) new_key: needed but not mapped
  SELECT
    'new_key'::text                          AS status,
    n.setting_key, n.label, n.rule_code, n.kind, n.required_account_type,
    NULL::uuid                               AS current_account_id,
    NULL::text                               AS current_account_code,
    NULL::text                               AS current_account_name,
    NULL::text                               AS current_source,
    NULL::text                               AS current_pack_version,
    i.pack_version                           AS installed_pack_version,
    n.suggested_account_id                   AS recommended_account_id,
    (SELECT a.code FROM public.accounts a WHERE a.id = n.suggested_account_id) AS recommended_account_code,
    (SELECT a.name FROM public.accounts a WHERE a.id = n.suggested_account_id) AS recommended_account_name
  FROM needed n
  LEFT JOIN installed i ON true
  WHERE n.is_mapped = false

  UNION ALL
  -- 2) deprecated_key: mapping exists but readiness no longer requires it
  SELECT
    'deprecated_key'::text,
    e.setting_key,
    e.setting_key                            AS label,
    NULL::text                               AS rule_code,
    'legacy'::text                           AS kind,
    NULL::text                               AS required_account_type,
    e.account_id, e.account_code, e.account_name,
    e.source, e.origin_pack_version, i.pack_version,
    NULL::uuid, NULL::text, NULL::text
  FROM public.default_account_settings e_row
  JOIN existing e ON e.setting_key = e_row.setting_key
  LEFT JOIN installed i ON true
  WHERE e_row.organization_id = _org_id
    AND (_business_id IS NULL OR e_row.business_id = _business_id)
    AND NOT EXISTS (
      SELECT 1 FROM needed n WHERE n.setting_key = e.setting_key
    )
    -- limit to payroll-shaped keys we know about via system_account_roles / kind
    AND (
      e.setting_key IN ('salary_expense','net_salary_payable','payroll_clearing')
      OR e.setting_key ~ '_(payable|employer_expense)$'
    )

  UNION ALL
  -- 3) stale_pack_version: pack-sourced mapping whose recorded version differs from installed
  SELECT
    'stale_pack_version'::text,
    n.setting_key, n.label, n.rule_code, n.kind, n.required_account_type,
    e.account_id, e.account_code, e.account_name,
    e.source, e.origin_pack_version, i.pack_version,
    n.suggested_account_id,
    (SELECT a.code FROM public.accounts a WHERE a.id = n.suggested_account_id),
    (SELECT a.name FROM public.accounts a WHERE a.id = n.suggested_account_id)
  FROM needed n
  JOIN existing e ON e.setting_key = n.setting_key
  JOIN installed i ON true
  WHERE n.is_mapped = true
    AND e.source IN ('pack_default','pack_upgrade')
    AND i.pack_version IS NOT NULL
    AND (e.origin_pack_version IS DISTINCT FROM i.pack_version)

  UNION ALL
  -- 4) changed_recommendation: mapped, but current suggester would pick a different account
  --    (only informational for pack-sourced rows without an explicit override reason)
  SELECT
    'changed_recommendation'::text,
    n.setting_key, n.label, n.rule_code, n.kind, n.required_account_type,
    e.account_id, e.account_code, e.account_name,
    e.source, e.origin_pack_version, i.pack_version,
    n.suggested_account_id,
    (SELECT a.code FROM public.accounts a WHERE a.id = n.suggested_account_id),
    (SELECT a.name FROM public.accounts a WHERE a.id = n.suggested_account_id)
  FROM needed n
  JOIN existing e ON e.setting_key = n.setting_key
  LEFT JOIN installed i ON true
  WHERE n.is_mapped = true
    AND n.suggested_account_id IS NOT NULL
    AND n.suggested_account_id <> e.account_id
    AND e.source IN ('pack_default','pack_upgrade')
    AND COALESCE(e.override_reason, '') = '';
END;
$function$;

GRANT EXECUTE ON FUNCTION public.payroll_gl_upgrade_diff(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.payroll_gl_upgrade_diff(uuid, uuid) IS
  'Phase 3 read-only classifier. Buckets every payroll GL mapping into new_key / deprecated_key / stale_pack_version / changed_recommendation relative to the currently active statutory rulebook and installed localization pack version. Purely informational — no writes.';
