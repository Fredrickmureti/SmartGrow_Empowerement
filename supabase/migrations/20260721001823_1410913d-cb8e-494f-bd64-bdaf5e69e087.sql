
-- =============================================================================
-- Phase 7-9 (ADR-0086 / D7-D10): media profiles, hardware-shaped printer
-- profiles, and media-keyed label templates.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. media_profiles: first-class physical paper/label dimensions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.media_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  width_mm numeric NOT NULL CHECK (width_mm > 0),
  height_mm numeric NULL CHECK (height_mm IS NULL OR height_mm > 0),
  orientation text NOT NULL DEFAULT 'portrait' CHECK (orientation IN ('portrait','landscape')),
  gap_mm numeric NOT NULL DEFAULT 3 CHECK (gap_mm >= 0),
  kind text NOT NULL DEFAULT 'label' CHECK (kind IN ('label','receipt','sheet','continuous')),
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS media_profiles_org_code_uniq
  ON public.media_profiles (org_id, code);
CREATE INDEX IF NOT EXISTS media_profiles_org_kind_idx
  ON public.media_profiles (org_id, kind, active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_profiles TO authenticated;
GRANT ALL ON public.media_profiles TO service_role;

ALTER TABLE public.media_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY media_profiles_org_read
  ON public.media_profiles FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid() AND uba.business_id = media_profiles.org_id
  ));

CREATE POLICY media_profiles_admin_write
  ON public.media_profiles FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), media_profiles.org_id, 'admin'::app_role)
    OR public.has_role(auth.uid(), media_profiles.org_id, 'owner'::app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), media_profiles.org_id, 'admin'::app_role)
    OR public.has_role(auth.uid(), media_profiles.org_id, 'owner'::app_role)
  );

CREATE TRIGGER media_profiles_touch
  BEFORE UPDATE ON public.media_profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Seed platform defaults per organization.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seed_default_media_profiles(p_org_id uuid)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_inserted int := 0;
BEGIN
  INSERT INTO public.media_profiles
    (org_id, code, name, width_mm, height_mm, orientation, gap_mm, kind, is_default)
  VALUES
    (p_org_id, 'receipt_40',   '40mm Thermal Receipt',   40,   NULL, 'portrait',  0, 'receipt',    false),
    (p_org_id, 'receipt_58',   '58mm Thermal Receipt',   58,   NULL, 'portrait',  0, 'receipt',    false),
    (p_org_id, 'receipt_80',   '80mm Thermal Receipt',   80,   NULL, 'portrait',  0, 'receipt',    true),
    (p_org_id, 'label_50x30',  'Label 50 x 30 mm',       50,   30,   'landscape', 3, 'label',      false),
    (p_org_id, 'label_80x50',  'Label 80 x 50 mm',       80,   50,   'landscape', 3, 'label',      true),
    (p_org_id, 'label_100x150','Label 100 x 150 mm',    100,  150,   'portrait',  3, 'label',      false),
    (p_org_id, 'sheet_a4',     'A4 Sheet',              210,  297,   'portrait',  0, 'sheet',      true),
    (p_org_id, 'sheet_letter', 'US Letter Sheet',       215.9,279.4, 'portrait',  0, 'sheet',      false)
  ON CONFLICT (org_id, code) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END $$;

REVOKE ALL ON FUNCTION public.seed_default_media_profiles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_default_media_profiles(uuid) TO authenticated, service_role;

-- Backfill: every existing organization gets the default media catalog.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM public.organizations LOOP
    PERFORM public.seed_default_media_profiles(r.id);
  END LOOP;
END $$;

-- Auto-seed on future org creation.
CREATE OR REPLACE FUNCTION public.tg_org_seed_media_profiles()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public.seed_default_media_profiles(NEW.id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_org_seed_media_profiles ON public.organizations;
CREATE TRIGGER trg_org_seed_media_profiles
  AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.tg_org_seed_media_profiles();

-- ---------------------------------------------------------------------------
-- 3. Promote printer_profiles to hardware capabilities.
-- ---------------------------------------------------------------------------
ALTER TABLE public.printer_profiles
  ADD COLUMN IF NOT EXISTS command_language text
    CHECK (command_language IN ('zpl','epl','escpos','pdf')),
  ADD COLUMN IF NOT EXISTS dpi int
    CHECK (dpi IS NULL OR dpi IN (152, 203, 300, 600)),
  ADD COLUMN IF NOT EXISTS margins_mm jsonb NOT NULL DEFAULT '{"top":0,"right":0,"bottom":0,"left":0}'::jsonb,
  ADD COLUMN IF NOT EXISTS supported_media_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS capabilities text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.printer_profiles.command_language IS
  'Hardware command language emitted by the driver (zpl|epl|escpos|pdf). Replaces the semantic use of paper_format for driver selection.';
COMMENT ON COLUMN public.printer_profiles.dpi IS
  'Physical print resolution in dots per inch. Authoritative source for dot conversion; device_assignments.config.dpi is deprecated.';
COMMENT ON COLUMN public.printer_profiles.supported_media_ids IS
  'Media profiles this printer accepts. Empty array = any (backwards compat).';

-- Backfill defaults from the existing paper_format enum.
UPDATE public.printer_profiles
   SET command_language = CASE
         WHEN paper_format IN ('80mm','58mm') THEN 'escpos'
         WHEN paper_format IN ('a4','letter','a5') THEN 'pdf'
         ELSE 'escpos'
       END
 WHERE command_language IS NULL;

UPDATE public.printer_profiles
   SET dpi = CASE
         WHEN paper_format IN ('80mm','58mm') THEN 203
         WHEN paper_format IN ('a4','letter','a5') THEN 300
         ELSE 203
       END
 WHERE dpi IS NULL;

-- ---------------------------------------------------------------------------
-- 4. label_templates.media_profile_id + media-aware unique key.
-- ---------------------------------------------------------------------------
ALTER TABLE public.label_templates
  ADD COLUMN IF NOT EXISTS media_profile_id uuid NULL
    REFERENCES public.media_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS label_templates_media_idx
  ON public.label_templates (media_profile_id) WHERE media_profile_id IS NOT NULL;

-- Backfill: link each label_templates row to the matching media profile
-- based on its stored width_mm/height_mm.
UPDATE public.label_templates lt
   SET media_profile_id = mp.id
  FROM public.media_profiles mp
 WHERE mp.org_id = lt.org_id
   AND lt.media_profile_id IS NULL
   AND lt.width_mm IS NOT NULL
   AND (
     (lt.width_mm = mp.width_mm AND (
        (lt.height_mm IS NULL AND mp.height_mm IS NULL) OR
        (lt.height_mm = mp.height_mm)
     ))
   );

-- Any row still unlinked defaults to the org's 'label_80x50' (labels) or
-- 'receipt_80' (escpos receipts).
UPDATE public.label_templates lt
   SET media_profile_id = mp.id
  FROM public.media_profiles mp
 WHERE lt.media_profile_id IS NULL
   AND mp.org_id = lt.org_id
   AND mp.code = CASE WHEN lt.engine = 'escpos' THEN 'receipt_80' ELSE 'label_80x50' END;

-- Swap unique indexes: media becomes part of the key.
DROP INDEX IF EXISTS public.label_templates_branch_key_uniq;
DROP INDEX IF EXISTS public.label_templates_org_key_uniq;

CREATE UNIQUE INDEX label_templates_branch_key_media_uniq
  ON public.label_templates (org_id, branch_id, template_key, COALESCE(media_profile_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE branch_id IS NOT NULL;

CREATE UNIQUE INDEX label_templates_org_key_media_uniq
  ON public.label_templates (org_id, template_key, COALESCE(media_profile_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE branch_id IS NULL;

-- ---------------------------------------------------------------------------
-- 5. Media-aware resolve_label_template.
--    Preference: (branch + exact media) > (branch + media-agnostic)
--              > (org + exact media)    > (org + media-agnostic)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.resolve_label_template(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.resolve_label_template(uuid, text, uuid, uuid);

CREATE OR REPLACE FUNCTION public.resolve_label_template(
  p_org_id uuid,
  p_template_key text,
  p_branch_id uuid DEFAULT NULL,
  p_media_profile_id uuid DEFAULT NULL
) RETURNS TABLE (
  id uuid,
  engine public.label_engine,
  body text,
  version int,
  kind text,
  scope text,
  media_profile_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH ranked AS (
    SELECT
      t.*,
      -- Prefer exact-media, then media-agnostic; prefer branch over org.
      CASE
        WHEN t.branch_id IS NOT DISTINCT FROM p_branch_id
             AND t.media_profile_id IS NOT DISTINCT FROM p_media_profile_id THEN 1
        WHEN t.branch_id IS NOT DISTINCT FROM p_branch_id
             AND t.media_profile_id IS NULL THEN 2
        WHEN t.branch_id IS NULL
             AND t.media_profile_id IS NOT DISTINCT FROM p_media_profile_id THEN 3
        WHEN t.branch_id IS NULL
             AND t.media_profile_id IS NULL THEN 4
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
$$;

REVOKE ALL ON FUNCTION public.resolve_label_template(uuid, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_label_template(uuid, text, uuid, uuid)
  TO authenticated, service_role;
