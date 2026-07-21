-- ADR-0087 · canonical resolver redeploy with idempotency guards.
-- Consolidates the CREATE, DROP-legacy, REVOKE and GRANT into a single
-- migration so a fresh clone builds identically to production and the
-- source-inspection guardrail in src/test/printing/media-profile-resolution.test.ts
-- has one authoritative file to check.

-- 1. Drop the legacy 3-arg signature first (idempotent redeploy).
DROP FUNCTION IF EXISTS public.resolve_label_template(uuid, text, uuid);

-- 2. Canonical definition. Body is byte-identical to the Phase-13 fix;
--    only lifecycle guards (DROP/REVOKE/GRANT) are added around it.
CREATE OR REPLACE FUNCTION public.resolve_label_template(
  p_org_id uuid,
  p_template_key text,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_media_profile_id uuid DEFAULT NULL::uuid
) RETURNS TABLE(id uuid, engine label_engine, body text, version integer, kind text, scope text, media_profile_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH ranked AS (
    SELECT
      t.*,
      CASE
        WHEN t.branch_id IS NOT DISTINCT FROM p_branch_id
             AND t.media_profile_id IS NOT DISTINCT FROM p_media_profile_id THEN 1
        WHEN t.branch_id IS NOT DISTINCT FROM p_branch_id
             AND t.media_profile_id IS NULL THEN 2
        WHEN t.branch_id IS NULL
             AND t.media_profile_id IS NOT DISTINCT FROM p_media_profile_id THEN 3
        WHEN t.branch_id IS NULL
             AND t.media_profile_id IS NULL THEN 4
        WHEN t.branch_id IS NULL
             AND p_media_profile_id IS NULL
             AND t.media_profile_id IS NOT NULL THEN 5
        ELSE 99
      END AS rnk,
      CASE
        WHEN t.branch_id IS NOT DISTINCT FROM p_branch_id THEN 'branch'
        ELSE 'org'
      END AS scope_label
    FROM public.label_templates t
    WHERE t.org_id = p_org_id
      AND t.active = true
      AND t.template_key = p_template_key
      AND (t.branch_id IS NULL OR t.branch_id = p_branch_id)
      AND (t.media_profile_id IS NULL OR p_media_profile_id IS NULL OR t.media_profile_id = p_media_profile_id)
  )
  SELECT id, engine, body, version, kind, scope_label, media_profile_id
  FROM ranked
  WHERE rnk < 99
  ORDER BY rnk ASC, version DESC
  LIMIT 1;
$function$;

-- 3. Lock down execution — SECURITY DEFINER + PUBLIC EXECUTE would let
--    any JWT-bearing caller bypass RLS on label_templates.
REVOKE ALL ON FUNCTION public.resolve_label_template(uuid, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_label_template(uuid, text, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_label_template(uuid, text, uuid, uuid) IS
  'Resolves a label template with 5-tier ranking: exact(branch+media) → branch+null-media → org+media → org+null-media → org+pinned-media(last-resort). ADR-0087. Locked to authenticated + service_role.';
