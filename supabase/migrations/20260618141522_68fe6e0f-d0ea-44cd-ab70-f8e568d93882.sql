
-- =========================================================================
-- Phase 1 + Phase 2: localization pack schema hardening
-- =========================================================================

-- 1) pack_versions.changelog -> jsonb (safe conversion)
ALTER TABLE public.pack_versions
  ALTER COLUMN changelog TYPE jsonb
  USING (
    CASE
      WHEN changelog IS NULL OR btrim(changelog) = '' THEN NULL
      WHEN left(btrim(changelog), 1) IN ('{','[') THEN changelog::jsonb
      ELSE jsonb_build_object('legacy_text', changelog)
    END
  );

-- 2) Re-publish detection + schema-version recording
ALTER TABLE public.pack_versions
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS schema_version int NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS pack_versions_content_hash_idx
  ON public.pack_versions (pack_id, content_hash);

-- 3) Uniqueness: prevent duplicate (pack_id, version) and duplicate proposals
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pack_versions_pack_version_uk'
  ) THEN
    ALTER TABLE public.pack_versions
      ADD CONSTRAINT pack_versions_pack_version_uk UNIQUE (pack_id, version);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pack_upgrade_proposals_target_uk'
  ) THEN
    ALTER TABLE public.pack_upgrade_proposals
      ADD CONSTRAINT pack_upgrade_proposals_target_uk
      UNIQUE (organization_id, business_id, pack_id, to_version);
  END IF;
END$$;

-- 4) Migration audit log
CREATE TABLE IF NOT EXISTS public.pack_migration_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  business_id uuid,
  pack_id uuid,
  pack_version text,
  scope text NOT NULL,                 -- 'platform_template' | 'tenant_rule' | 'tax_rate' | 'account'
  entity_table text NOT NULL,
  entity_id uuid,
  reason text NOT NULL,                -- 'self_heal_missing_required' | 'pack_upgrade_apply' | ...
  before_value jsonb,
  after_value jsonb,
  applied_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.pack_migration_log TO authenticated;
GRANT ALL ON public.pack_migration_log TO service_role;

ALTER TABLE public.pack_migration_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins read all migration log"
  ON public.pack_migration_log FOR SELECT
  TO authenticated
  USING (public.is_platform_admin(auth.uid()));

CREATE POLICY "Org members read their migration log"
  ON public.pack_migration_log FOR SELECT
  TO authenticated
  USING (
    organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = pack_migration_log.organization_id
        AND ur.is_active = true
    )
  );

CREATE INDEX IF NOT EXISTS pack_migration_log_org_idx
  ON public.pack_migration_log (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pack_migration_log_pack_idx
  ON public.pack_migration_log (pack_id, created_at DESC);

-- 5) Conflict registry for tenant-customised rules during pack upgrade
CREATE TABLE IF NOT EXISTS public.pack_rule_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  pack_id uuid NOT NULL,
  from_version text,
  to_version text NOT NULL,
  rule_table text NOT NULL,            -- 'payroll_statutory_rules' | 'tax_rates' | 'accounts'
  rule_id uuid,
  rule_code text,
  tenant_value jsonb,
  incoming_value jsonb,
  status text NOT NULL DEFAULT 'pending', -- pending | kept_tenant | accepted_incoming
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, UPDATE ON public.pack_rule_conflicts TO authenticated;
GRANT ALL ON public.pack_rule_conflicts TO service_role;

ALTER TABLE public.pack_rule_conflicts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members read their conflicts"
  ON public.pack_rule_conflicts FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = pack_rule_conflicts.organization_id
        AND ur.is_active = true
    )
    OR public.is_platform_admin(auth.uid())
  );

CREATE POLICY "Org members resolve their conflicts"
  ON public.pack_rule_conflicts FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = pack_rule_conflicts.organization_id
        AND ur.is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = pack_rule_conflicts.organization_id
        AND ur.is_active = true
    )
  );

CREATE INDEX IF NOT EXISTS pack_rule_conflicts_org_idx
  ON public.pack_rule_conflicts (organization_id, status);

-- 6) Self-heal trigger for backfill is handled by application code (see edge function).
--    No data mutation in this migration so it is safe to re-run.
