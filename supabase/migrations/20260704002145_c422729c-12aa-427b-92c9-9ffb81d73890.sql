
-- ============================================================================
-- Phase 5 — Effective-dated GL mapping bindings (branch-aware)
-- ============================================================================

-- 1) Table
CREATE TABLE IF NOT EXISTS public.default_account_setting_bindings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id          uuid,
  branch_id            uuid,
  setting_key          text NOT NULL,
  account_id           uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  effective_from       timestamptz NOT NULL DEFAULT now(),
  effective_to         timestamptz,
  source               text NOT NULL DEFAULT 'manual'
                         CHECK (source IN ('pack_default','pack_upgrade','tenant_override','manual','system_seed')),
  origin_pack_id       uuid,
  origin_pack_version  text,
  overridden_by        uuid,
  override_reason      text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

GRANT SELECT ON public.default_account_setting_bindings TO authenticated;
GRANT ALL   ON public.default_account_setting_bindings TO service_role;

ALTER TABLE public.default_account_setting_bindings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read their org bindings" ON public.default_account_setting_bindings;
CREATE POLICY "Members read their org bindings"
  ON public.default_account_setting_bindings
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = default_account_setting_bindings.organization_id
        AND ur.is_active = true
    )
  );

-- Only one OPEN binding per (org, business, branch, setting_key). Historical
-- rows are always closed (effective_to IS NOT NULL) so this partial unique
-- index is the correct enforcement point.
CREATE UNIQUE INDEX IF NOT EXISTS uq_default_account_setting_bindings_open
  ON public.default_account_setting_bindings (
    organization_id,
    COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(branch_id,   '00000000-0000-0000-0000-000000000000'::uuid),
    setting_key
  )
  WHERE effective_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_default_account_setting_bindings_lookup
  ON public.default_account_setting_bindings
     (organization_id, setting_key, effective_from DESC);

COMMENT ON TABLE public.default_account_setting_bindings IS
  'Phase 5: effective-dated history of every GL-mapping change. One OPEN binding per (org, business, branch, setting_key); prior values are closed with effective_to. Populated by trg_default_account_settings_binding_sync.';

-- 2) Sync trigger — write-through from the flat table
CREATE OR REPLACE FUNCTION public._default_account_settings_binding_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org uuid;
  _biz uuid;
  _br  uuid;
  _key text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.default_account_setting_bindings
       SET effective_to = now()
     WHERE organization_id = OLD.organization_id
       AND business_id IS NOT DISTINCT FROM OLD.business_id
       AND branch_id   IS NOT DISTINCT FROM OLD.branch_id
       AND setting_key = OLD.setting_key
       AND effective_to IS NULL;
    RETURN OLD;
  END IF;

  _org := NEW.organization_id;
  _biz := NEW.business_id;
  _br  := NEW.branch_id;
  _key := NEW.setting_key;

  -- Skip when nothing changed on UPDATE (same account, same source)
  IF TG_OP = 'UPDATE'
     AND OLD.account_id = NEW.account_id
     AND COALESCE(OLD.source,'')  = COALESCE(NEW.source,'')
  THEN
    RETURN NEW;
  END IF;

  -- Close previous open binding at the same scope+key
  UPDATE public.default_account_setting_bindings
     SET effective_to = now()
   WHERE organization_id = _org
     AND business_id IS NOT DISTINCT FROM _biz
     AND branch_id   IS NOT DISTINCT FROM _br
     AND setting_key = _key
     AND effective_to IS NULL
     AND account_id  <> NEW.account_id;

  -- Open a new binding (only if no matching open row already exists)
  INSERT INTO public.default_account_setting_bindings
    (organization_id, business_id, branch_id, setting_key, account_id,
     effective_from, source, origin_pack_id, origin_pack_version,
     overridden_by, override_reason)
  SELECT _org, _biz, _br, _key, NEW.account_id,
         now(), COALESCE(NEW.source,'manual'),
         NEW.origin_pack_id, NEW.origin_pack_version,
         NEW.overridden_by, NEW.override_reason
   WHERE NOT EXISTS (
     SELECT 1 FROM public.default_account_setting_bindings b
      WHERE b.organization_id = _org
        AND b.business_id IS NOT DISTINCT FROM _biz
        AND b.branch_id   IS NOT DISTINCT FROM _br
        AND b.setting_key = _key
        AND b.effective_to IS NULL
        AND b.account_id  = NEW.account_id
   );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_default_account_settings_binding_sync
  ON public.default_account_settings;
CREATE TRIGGER trg_default_account_settings_binding_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.default_account_settings
  FOR EACH ROW EXECUTE FUNCTION public._default_account_settings_binding_sync();

-- 3) Backfill one open binding per existing row (idempotent)
INSERT INTO public.default_account_setting_bindings
  (organization_id, business_id, branch_id, setting_key, account_id,
   effective_from, source, origin_pack_id, origin_pack_version,
   overridden_by, override_reason)
SELECT d.organization_id, d.business_id, d.branch_id, d.setting_key, d.account_id,
       COALESCE(d.created_at, now()), COALESCE(d.source,'manual'),
       d.origin_pack_id, d.origin_pack_version,
       d.overridden_by, d.override_reason
  FROM public.default_account_settings d
 WHERE NOT EXISTS (
   SELECT 1 FROM public.default_account_setting_bindings b
    WHERE b.organization_id = d.organization_id
      AND b.business_id IS NOT DISTINCT FROM d.business_id
      AND b.branch_id   IS NOT DISTINCT FROM d.branch_id
      AND b.setting_key = d.setting_key
      AND b.effective_to IS NULL
 );

-- 4) Resolver — most-specific scope first, honours as_of window
CREATE OR REPLACE FUNCTION public.resolve_default_account_binding(
  _setting_key text,
  _org_id      uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id   uuid DEFAULT NULL,
  _as_of       timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidates AS (
    SELECT b.account_id,
           CASE
             WHEN _branch_id IS NOT NULL AND b.branch_id = _branch_id THEN 0
             WHEN _business_id IS NOT NULL AND b.business_id = _business_id
                  AND b.branch_id IS NULL THEN 1
             WHEN b.business_id IS NULL AND b.branch_id IS NULL THEN 2
             ELSE 9
           END AS specificity,
           b.effective_from
      FROM public.default_account_setting_bindings b
     WHERE b.organization_id = _org_id
       AND b.setting_key = _setting_key
       AND b.effective_from <= _as_of
       AND (b.effective_to IS NULL OR b.effective_to > _as_of)
  )
  SELECT account_id
    FROM candidates
   WHERE specificity < 9
   ORDER BY specificity, effective_from DESC
   LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_default_account_binding(text, uuid, uuid, uuid, timestamptz)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_default_account_binding IS
  'Phase 5: branch/business/org-cascading, effective-dated lookup for a payroll GL mapping. Returns the account_id that was in effect at _as_of for the most-specific matching scope. Falls back to business, then org-level. NULL when no binding matches.';
