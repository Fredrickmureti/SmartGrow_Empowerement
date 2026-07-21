
-- Phase 13 · ADR-0087 housekeeping audit (diagnostic-only).
--
-- The Phase-13 fix migration `20260721005711_*.sql` repaired every
-- `is_default = true AND branch_id IS NULL` row by nulling
-- `media_profile_id`. That covers the class of defect that produced
-- the "no template registered for key 'product_label'" bug.
--
-- This migration audits the sibling class: non-default org-scope rows
-- (`is_default = false AND branch_id IS NULL AND media_profile_id IS NOT NULL`).
-- Those MAY be intentional media variants — the ADR-0087 invariant only
-- constrains DEFAULTS to be media-agnostic. Blanket-nulling them would
-- destroy legitimate branch/media overrides.
--
-- We therefore emit a `RAISE NOTICE` for each survivor so operators can
-- review manually against the Platform → Hardware surface. If a survivor
-- was in fact introduced by a Phase-9/10 seed (not a user CRUD action),
-- a follow-up migration will null it by explicit id. The resolver's
-- `rnk=5` last-resort arm (migration 20260721005711) already prevents
-- silent-drop regressions in the meantime.
--
-- No UPDATE / DELETE is performed by this migration.

DO $$
DECLARE
  r RECORD;
  n_survivors integer := 0;
BEGIN
  FOR r IN
    SELECT lt.id,
           lt.org_id,
           lt.template_key,
           lt.name,
           lt.media_profile_id,
           lt.created_at,
           lt.updated_at
    FROM public.label_templates lt
    WHERE lt.is_default = false
      AND lt.branch_id IS NULL
      AND lt.media_profile_id IS NOT NULL
      AND lt.active = true
    ORDER BY lt.org_id, lt.template_key, lt.created_at
  LOOP
    n_survivors := n_survivors + 1;
    RAISE NOTICE
      'ADR-0087 audit · non-default org-scope row still pins media: id=% org=% key=% name=% media_profile_id=% created_at=% updated_at=%',
      r.id, r.org_id, r.template_key, r.name, r.media_profile_id, r.created_at, r.updated_at;
  END LOOP;

  IF n_survivors = 0 THEN
    RAISE NOTICE 'ADR-0087 audit · no non-default org-scope rows pin a media profile. Clean.';
  ELSE
    RAISE NOTICE 'ADR-0087 audit · % survivor(s) listed above. Review manually; the rnk=5 last-resort resolver arm still resolves each row for callers with no media.', n_survivors;
  END IF;
END $$;
