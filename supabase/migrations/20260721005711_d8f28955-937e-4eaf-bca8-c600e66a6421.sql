
-- Fix ADR-0087 default label template seed: defaults must be media-agnostic
-- so `resolve_label_template` can find them when the caller has no
-- resolved media (e.g., orgs with no printer_profile / workflow binding yet).

-- 1. Null out media_profile_id on existing DEFAULT templates so the
--    resolver's media-agnostic ranks (2, 4) match them. Specific media
--    variants (non-default) are left untouched.
UPDATE public.label_templates
SET media_profile_id = NULL,
    updated_at = now()
WHERE is_default = true
  AND branch_id IS NULL
  AND media_profile_id IS NOT NULL;

-- 2. Extend the resolver with a rnk=5 "last-resort" case: template pins
--    a media_profile_id but caller passed none. This keeps
--    caller-with-media the strong match (rnk=1..4) while making sure a
--    misconfigured seed can never again return "no template registered"
--    when a row actually exists.
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
        -- rnk=5: last-resort. Template pins a media_profile_id but caller
        -- didn't request one (no printer/workflow binding yet). Better to
        -- print with a pinned-geometry default than to fail silently.
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

-- 3. Fix the per-org seed trigger function so future organizations receive
--    the default template with media_profile_id = NULL. We inline the
--    canonical ZPL body (content-only, no envelope — ADR-0087) rather
--    than reference a specific media_profiles row.
CREATE OR REPLACE FUNCTION public.seed_default_label_templates()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.label_templates
    (org_id, branch_id, kind, template_key, name, engine, body,
     width_mm, height_mm, is_default, version, active, media_profile_id)
  VALUES (
    NEW.id,
    NULL,
    'product',
    'product_label',
    'Default product label',
    'zpl',
    '^XA^CF0,28^FO20,20^FD{{name}}^FS^CF0,22^FO20,60^FD{{sku}}^FS^BY2,2,80^FO20,100^BCN,80,Y,N,N^FD{{barcode}}^FS^XZ',
    NULL, NULL, true, 1, true,
    NULL  -- media-agnostic default (ADR-0087)
  )
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.resolve_label_template(uuid, text, uuid, uuid) IS
  'Resolves a label template with 5-tier ranking: exact(branch+media) → branch+null-media → org+media → org+null-media → org+pinned-media(last-resort). ADR-0087.';
COMMENT ON FUNCTION public.seed_default_label_templates() IS
  'Seeds the media-agnostic default product_label template on organization insert. ADR-0087: defaults own content only; geometry is resolved from media_profiles at print time.';
