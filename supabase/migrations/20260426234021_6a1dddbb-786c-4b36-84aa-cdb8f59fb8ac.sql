-- Per-company logo (Odoo `res.company` model). businesses.logo_url is the
-- single source of truth for customer-facing branding; organizations.logo_url
-- is deprecated and will be dropped in a follow-up migration.

-- 1) Backfill: for each org with a logo, copy it to its primary (oldest
--    active) business if that business has no logo yet. This preserves
--    existing branding for current customers without silently fanning a
--    workspace logo out to every business in multi-company workspaces.
WITH primary_business AS (
  SELECT DISTINCT ON (b.organization_id)
         b.id, b.organization_id
  FROM public.businesses b
  WHERE b.is_active = true AND b.logo_url IS NULL
  ORDER BY b.organization_id, b.created_at ASC
)
UPDATE public.businesses b
SET logo_url = o.logo_url,
    updated_at = now()
FROM public.organizations o
JOIN primary_business pb ON pb.organization_id = o.id
WHERE b.id = pb.id
  AND o.logo_url IS NOT NULL
  AND b.logo_url IS NULL;

-- 2) Mark org-level logo as deprecated (column kept for back-compat for one release).
COMMENT ON COLUMN public.organizations.logo_url IS
  'DEPRECATED — use businesses.logo_url. Per-company branding (Odoo res.company model). Will be dropped in a follow-up migration once all readers are removed.';