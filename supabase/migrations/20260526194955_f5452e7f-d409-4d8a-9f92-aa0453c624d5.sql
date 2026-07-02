-- Revoke broad access; orphan inventory is platform-admin data only.
REVOKE ALL ON public.storage_orphan_inventory FROM authenticated, anon;

-- Recreate without an auth.users reference. We resolve user-owner
-- existence at query time inside the platform-admin edge function /
-- server fn instead. For users the inventory simply reports the
-- owner_user_id; the caller (service_role) joins against auth.users.
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
    WHEN soo.owner_kind = 'organization'
      THEN NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = soo.organization_id)
    WHEN soo.owner_kind = 'unknown'
      THEN TRUE
    ELSE FALSE  -- user/entity orphan detection happens in the GC function.
  END AS is_orphan
FROM public.storage_object_ownership soo;

GRANT SELECT ON public.storage_orphan_inventory TO service_role;
