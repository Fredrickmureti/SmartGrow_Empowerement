
-- =====================================================================
-- Phase 3+4: Storage GC orphan-detection hardening
-- =====================================================================
-- Goals:
--  1. Detect orphans of every owner_kind (organization, user, entity)
--     without an artificial 7-day grace that hides real, backfilled
--     orphans forever-minus-7-days.
--  2. Make the grace window an explicit caller-controlled parameter
--     (default 0). This preserves the original safety knob without
--     making it the silent default.
--  3. Rebuild the platform-admin orphan-inventory view so it agrees
--     with the resolver.
--
-- Safety: this migration changes DETECTION ONLY. No file is deleted.
-- The shared `runStorageGc` helper continues to gate deletion behind
-- the `dryRun` flag and the platform-admin call sites.

-- ---------------------------------------------------------------------
-- 1. Resolver: drop & recreate with new signature
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.storage_gc_resolve_objects(text, text);

CREATE OR REPLACE FUNCTION public.storage_gc_resolve_objects(
  p_scope          text,
  p_target_id      text     DEFAULT NULL,
  p_grace_interval interval DEFAULT '0 seconds'
)
RETURNS TABLE (
  bucket_id       text,
  object_name     text,
  owner_kind      text,
  organization_id uuid,
  owner_user_id   uuid,
  entity_type     text,
  entity_id       text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_scope NOT IN ('organization','user','entity','orphan') THEN
    RAISE EXCEPTION 'Invalid scope: %', p_scope;
  END IF;

  IF p_scope IN ('organization','user','entity') AND p_target_id IS NULL THEN
    RAISE EXCEPTION 'target_id required for scope %', p_scope;
  END IF;

  IF p_grace_interval < interval '0 seconds' THEN
    RAISE EXCEPTION 'grace_interval must be non-negative';
  END IF;

  RETURN QUERY
  SELECT
    o.bucket_id,
    o.object_name,
    o.owner_kind,
    o.organization_id,
    o.owner_user_id,
    o.entity_type,
    o.entity_id
  FROM public.storage_object_ownership o
  WHERE
    CASE p_scope
      WHEN 'organization' THEN o.organization_id = p_target_id::uuid
      WHEN 'user'         THEN o.owner_user_id   = p_target_id::uuid
      WHEN 'entity'       THEN o.entity_id       = p_target_id
      WHEN 'orphan' THEN
        o.inferred_at <= now() - p_grace_interval
        AND (
          -- Organization orphan: row claims an org that no longer exists
          (o.owner_kind = 'organization'
             AND o.organization_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM public.organizations org
               WHERE org.id = o.organization_id
             ))
          OR
          -- User orphan: row claims a user that no longer exists
          (o.owner_kind = 'user'
             AND o.owner_user_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM auth.users u
               WHERE u.id = o.owner_user_id
             ))
          OR
          -- Entity orphan (currently only the legacy 'contact' convention
          -- on custom-field-attachments). Conservative: only mark orphan
          -- when we can prove the parent contact is gone.
          (o.owner_kind = 'entity'
             AND o.entity_type = 'contact'
             AND o.entity_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM public.contacts c
               WHERE c.id::text = o.entity_id
             ))
          OR
          -- Unknown owner_kind that has stayed unknown past the grace
          -- window is a true orphan (no convention claimed it).
          (o.owner_kind = 'unknown')
        )
    END;
END;
$$;

REVOKE ALL ON FUNCTION public.storage_gc_resolve_objects(text, text, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.storage_gc_resolve_objects(text, text, interval) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.storage_gc_resolve_objects(text, text, interval) TO service_role;

COMMENT ON FUNCTION public.storage_gc_resolve_objects(text, text, interval) IS
  'Resolves storage ownership rows for the storage garbage collector. '
  'p_grace_interval lets callers require a minimum age since inference '
  'before an orphan becomes eligible (default 0 — definitive proofs are trusted immediately).';

-- ---------------------------------------------------------------------
-- 2. Rebuild orphan inventory view with full coverage
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS public.storage_orphan_inventory;

CREATE VIEW public.storage_orphan_inventory
WITH (security_invoker = on) AS
SELECT
  soo.bucket_id,
  soo.object_name,
  soo.owner_kind,
  soo.organization_id,
  soo.owner_user_id,
  soo.entity_type,
  soo.entity_id,
  soo.module,
  soo.is_legacy_path,
  soo.needs_review,
  soo.inferred_at,
  CASE
    WHEN soo.owner_kind = 'organization' THEN
      soo.organization_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = soo.organization_id)
    WHEN soo.owner_kind = 'user' THEN
      soo.owner_user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = soo.owner_user_id)
    WHEN soo.owner_kind = 'entity' AND soo.entity_type = 'contact' THEN
      soo.entity_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.id::text = soo.entity_id)
    WHEN soo.owner_kind = 'unknown' THEN TRUE
    ELSE FALSE
  END AS is_orphan
FROM public.storage_object_ownership soo;

REVOKE ALL ON public.storage_orphan_inventory FROM PUBLIC, authenticated, anon;
GRANT SELECT ON public.storage_orphan_inventory TO service_role;

COMMENT ON VIEW public.storage_orphan_inventory IS
  'Platform-admin orphan inventory. Mirrors the resolver in '
  'storage_gc_resolve_objects(scope=>orphan). Service-role only.';
