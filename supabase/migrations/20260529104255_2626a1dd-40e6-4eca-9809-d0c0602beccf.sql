-- =====================================================================
-- COA Remediation — Wave 1A: canonical system_role identity (foundation)
--
-- Re-verified context (live DB, 2026-05-29):
--   * accounts has is_system boolean but NO stable canonical identity for
--     system-provisioned rows. Eight different functions insert into
--     public.accounts; none of them coordinate by a shared key.
--   * default_chart_of_accounts has no role_key — the neutral skeleton
--     cannot be tied back to system_account_roles deterministically.
--   * localization_pack_account_templates has no role_key — packs cannot
--     identify which seed row corresponds to which canonical role, which
--     is why the Kenya pack collides with the neutral seeder on every
--     install (5010 vs 5100, 1020 vs 1100, 6011 vs 6151, etc.).
--
-- This migration adds the *identity* (system_role / role_key columns and
-- a partial unique index) but does NOT yet rewrite seeders or backfill
-- data. Wave 1B introduces the canonical role→code mapping table and
-- backfills existing system rows; Wave 1C rewrites the eight insertion
-- paths to UPSERT on (business_id, system_role); Wave 2 backfills the
-- Kenya pack's detail_type via role_key; Wave 3 ships repair_tenant_coa
-- and tightens enforce_account_lifecycle.
--
-- Splitting waves this way means each migration is independently
-- reviewable and revertable. A single mega-migration touching all eight
-- functions would be impossible to validate or roll back safely.
--
-- THIS MIGRATION IS PURE DDL. NO FUNCTION BODIES CHANGE. NO ROWS CHANGE.
-- =====================================================================

-- 1. accounts.system_role — canonical identity for system-provisioned rows
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS system_role text;

COMMENT ON COLUMN public.accounts.system_role IS
  'Canonical role key (matches public.system_account_roles.role_key) for system-provisioned accounts. NULL for user-created accounts. Once set, this column is the stable identity referenced by seeders, mappings, and the repair RPC — never the human-readable code or name.';

-- 2. Partial unique index: at most one system account per (business, role).
--    Partial so user accounts (system_role IS NULL) are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS accounts_business_system_role_uniq
  ON public.accounts (business_id, system_role)
  WHERE system_role IS NOT NULL;

-- 3. default_chart_of_accounts.role_key — link neutral skeleton to roles
ALTER TABLE public.default_chart_of_accounts
  ADD COLUMN IF NOT EXISTS role_key text;

COMMENT ON COLUMN public.default_chart_of_accounts.role_key IS
  'When non-null, identifies this template row as the canonical seed for the named role_key (FK to system_account_roles.role_key). Wave 1B populates this for the neutral skeleton; Wave 1C rewrites provision_default_chart_of_accounts to copy role_key into accounts.system_role.';

-- 4. localization_pack_account_templates.role_key — link pack rows to roles
ALTER TABLE public.localization_pack_account_templates
  ADD COLUMN IF NOT EXISTS role_key text;

COMMENT ON COLUMN public.localization_pack_account_templates.role_key IS
  'When non-null, identifies this pack template row as the canonical seed for the named role_key. Wave 2 backfills this for every published pack and adds a publish-time validation trigger. With role_key populated, the install path UPSERTs on (business_id, system_role) instead of inserting parallel rows.';

-- 5. Diagnostic view for the repair RPC (Wave 3) and architecture tests.
--    Read-only: surfaces rows that look like system accounts (is_system=true
--    OR code matches a neutral-skeleton code) but have system_role IS NULL.
--    Useful right now to confirm the duplication footprint without writing
--    any data. After Wave 1B backfill this view should return zero rows for
--    correctly-provisioned tenants.
CREATE OR REPLACE VIEW public.v_unidentified_system_accounts AS
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
  'Read-only diagnostic. Lists accounts that look like system rows but have no canonical system_role assigned. Wave 1B backfill should drive this to empty for healthy tenants; non-empty rows after Wave 1B indicate residual duplicates that repair_tenant_coa (Wave 3) will handle.';

-- 6. Grants — additive, additive-only DDL needs no GRANT changes for
--    existing tables. The new view inherits the same grants as accounts
--    by virtue of querying it; we grant explicitly anyway for clarity.
GRANT SELECT ON public.v_unidentified_system_accounts TO authenticated;
GRANT SELECT ON public.v_unidentified_system_accounts TO service_role;
