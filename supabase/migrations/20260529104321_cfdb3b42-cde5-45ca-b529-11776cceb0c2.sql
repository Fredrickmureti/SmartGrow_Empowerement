-- Wave 1A.1 — recreate the diagnostic view with security_invoker so it
-- runs with the querying user's RLS, not the creator's. Fixes the
-- "Security Definer View" linter error introduced by Wave 1A.
DROP VIEW IF EXISTS public.v_unidentified_system_accounts;

CREATE VIEW public.v_unidentified_system_accounts
WITH (security_invoker = true) AS
SELECT
  a.id,
  a.organization_id,
  a.business_id,
  a.code,
  a.name,
  a.account_type,
  a.detail_type,
  a.is_system
FROM public.accounts a
WHERE a.system_role IS NULL
  AND (a.is_system = true OR a.detail_type IS NULL);

COMMENT ON VIEW public.v_unidentified_system_accounts IS
  'Read-only diagnostic. Lists accounts that look like system rows but have no canonical system_role assigned. Runs with caller RLS (security_invoker=true). Wave 1B backfill should drive this to empty for healthy tenants; non-empty rows after Wave 1B indicate residual duplicates that repair_tenant_coa (Wave 3) will handle.';

GRANT SELECT ON public.v_unidentified_system_accounts TO authenticated;
GRANT SELECT ON public.v_unidentified_system_accounts TO service_role;
