-- Phase 18: Visual Label Designer
-- Add structured body_json alongside the legacy body column.
ALTER TABLE public.label_templates
  ADD COLUMN IF NOT EXISTS body_json JSONB NULL;

COMMENT ON COLUMN public.label_templates.body_json IS
  'Structured element list authored in the visual designer (ADR-0090). When present, the dispatcher compiles this to engine-native bytes and ignores body. Legacy raw-body templates remain supported until migrated.';

-- Update the resolver to also return body_json so the client can prefer it.
DROP FUNCTION IF EXISTS public.resolve_label_template(uuid, text, uuid, uuid);

CREATE OR REPLACE FUNCTION public.resolve_label_template(
  p_org_id uuid,
  p_template_key text,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_media_profile_id uuid DEFAULT NULL::uuid
) RETURNS TABLE(id uuid, engine label_engine, body text, body_json jsonb, version integer, kind text, scope text, media_profile_id uuid)
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
  SELECT id, engine, body, body_json, version, kind, scope_label, media_profile_id
  FROM ranked
  WHERE rnk < 99
  ORDER BY rnk ASC, version DESC
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.resolve_label_template(uuid, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_label_template(uuid, text, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_label_template(uuid, text, uuid, uuid) IS
  'Resolves a label template with 5-tier ranking: exact(branch+media) → branch+null-media → org+media → org+null-media → org+pinned-media(last-resort). Returns both raw body and structured body_json; caller compiles body_json when present (ADR-0087 + ADR-0090).';
