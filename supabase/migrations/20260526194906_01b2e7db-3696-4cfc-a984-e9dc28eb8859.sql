-- =====================================================================
-- Phase 1 — Storage governance foundation
-- =====================================================================

-- 1. Convention registry
CREATE TABLE IF NOT EXISTS public.storage_bucket_conventions (
  id               UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  bucket_id        TEXT NOT NULL REFERENCES storage.buckets(id) ON DELETE CASCADE,
  owner_kind       TEXT NOT NULL CHECK (owner_kind IN ('organization','user','entity')),
  path_regex       TEXT NOT NULL,
  path_template    TEXT NOT NULL,
  module           TEXT NOT NULL DEFAULT 'core',
  priority         INTEGER NOT NULL DEFAULT 100,
  is_legacy        BOOLEAN NOT NULL DEFAULT FALSE,
  entity_table     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bucket_id, path_regex)
);

CREATE INDEX IF NOT EXISTS idx_storage_bucket_conventions_bucket
  ON public.storage_bucket_conventions (bucket_id, priority);

GRANT SELECT ON public.storage_bucket_conventions TO authenticated;
GRANT ALL    ON public.storage_bucket_conventions TO service_role;

ALTER TABLE public.storage_bucket_conventions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Conventions readable by authenticated"
  ON public.storage_bucket_conventions
  FOR SELECT
  TO authenticated
  USING (TRUE);

-- 2. Ownership table
CREATE TABLE IF NOT EXISTS public.storage_object_ownership (
  bucket_id        TEXT NOT NULL,
  object_name      TEXT NOT NULL,
  owner_kind       TEXT NOT NULL CHECK (owner_kind IN ('organization','user','entity','unknown')),
  organization_id  UUID,
  owner_user_id    UUID,
  entity_type      TEXT,
  entity_id        TEXT,
  module           TEXT NOT NULL DEFAULT 'core',
  convention_id    UUID REFERENCES public.storage_bucket_conventions(id) ON DELETE SET NULL,
  is_legacy_path   BOOLEAN NOT NULL DEFAULT FALSE,
  needs_review     BOOLEAN NOT NULL DEFAULT FALSE,
  inferred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_id, object_name)
);

CREATE INDEX IF NOT EXISTS idx_storage_ownership_org
  ON public.storage_object_ownership (organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_storage_ownership_user
  ON public.storage_object_ownership (owner_user_id)   WHERE owner_user_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_storage_ownership_review
  ON public.storage_object_ownership (needs_review)    WHERE needs_review;
CREATE INDEX IF NOT EXISTS idx_storage_ownership_legacy
  ON public.storage_object_ownership (is_legacy_path)  WHERE is_legacy_path;

GRANT SELECT ON public.storage_object_ownership TO authenticated;
GRANT ALL    ON public.storage_object_ownership TO service_role;

ALTER TABLE public.storage_object_ownership ENABLE ROW LEVEL SECURITY;

-- Tenant users see ownership rows for organizations they have access to.
-- Membership is stored in public.user_business_access.
CREATE POLICY "Ownership readable to org members"
  ON public.storage_object_ownership
  FOR SELECT
  TO authenticated
  USING (
    organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.organization_id = storage_object_ownership.organization_id
        AND uba.user_id = auth.uid()
    )
  );

-- 3. Seed conventions
INSERT INTO public.storage_bucket_conventions
  (bucket_id, owner_kind, path_regex, path_template, module, priority, is_legacy, entity_table)
VALUES
  ('receipts',                 'organization', '^([0-9a-f-]{36})/',                          '<org_id>/...',                                    'pos',         100, FALSE, NULL),
  ('organization-assets',      'organization', '^([0-9a-f-]{36})/',                          '<org_id>/...',                                    'core',        100, FALSE, NULL),
  ('product-images',           'organization', '^([0-9a-f-]{36})/',                          '<org_id>/...',                                    'inventory',   100, FALSE, NULL),
  ('documents',                'organization', '^([0-9a-f-]{36})/',                          '<org_id>/...',                                    'core',        100, FALSE, NULL),
  ('documents',                'organization', '^payroll/tax-certificates/([0-9a-f-]{36})/', 'payroll/tax-certificates/<org_id>/... (legacy)',  'payroll',     200, TRUE,  NULL),
  ('document-pdfs',            'organization', '^([0-9a-f-]{36})/',                          '<org_id>/...',                                    'sales',       100, FALSE, NULL),
  ('employee-avatars',         'organization', '^([0-9a-f-]{36})/',                          '<org_id>/...',                                    'hr',          100, FALSE, NULL),
  ('employee-documents',       'organization', '^([0-9a-f-]{36})/',                          '<org_id>/...',                                    'hr',          100, FALSE, NULL),
  ('project-documents',        'organization', '^([0-9a-f-]{36})/',                          '<org_id>/...',                                    'projects',    100, FALSE, NULL),
  ('delivery-proofs',          'organization', '^([0-9a-f-]{36})/',                          '<org_id>/...',                                    'logistics',   100, FALSE, NULL),
  ('governance-exports',       'organization', '^([0-9a-f-]{36})/',                          '<org_id>/...',                                    'governance',  100, FALSE, NULL),
  ('user-avatars',             'user',         '^([0-9a-f-]{36})/',                          '<user_id>/...',                                   'core',        100, FALSE, NULL),
  ('custom-field-attachments', 'organization', '^([0-9a-f-]{36})/',                          '<org_id>/...',                                    'core',        100, FALSE, NULL),
  ('custom-field-attachments', 'entity',       '^(contact)/([^/]+)/',                        'contact/<entity_id>/... (legacy)',                'crm',         200, TRUE,  'contacts')
ON CONFLICT (bucket_id, path_regex) DO NOTHING;

-- 4. Inference function
CREATE OR REPLACE FUNCTION public.register_storage_object(
  p_bucket TEXT,
  p_name   TEXT,
  p_owner  UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_conv         public.storage_bucket_conventions%ROWTYPE;
  v_match        TEXT[];
  v_org_id       UUID;
  v_user_id      UUID;
  v_entity_type  TEXT;
  v_entity_id    TEXT;
  v_matched      BOOLEAN := FALSE;
BEGIN
  FOR v_conv IN
    SELECT * FROM public.storage_bucket_conventions
    WHERE bucket_id = p_bucket
    ORDER BY priority ASC, created_at ASC
  LOOP
    v_match := regexp_match(p_name, v_conv.path_regex);
    IF v_match IS NULL THEN
      CONTINUE;
    END IF;

    v_matched := TRUE;
    v_org_id := NULL; v_user_id := NULL; v_entity_type := NULL; v_entity_id := NULL;

    IF v_conv.owner_kind = 'organization' THEN
      BEGIN v_org_id := v_match[1]::UUID; EXCEPTION WHEN OTHERS THEN v_org_id := NULL; END;
    ELSIF v_conv.owner_kind = 'user' THEN
      BEGIN v_user_id := v_match[1]::UUID; EXCEPTION WHEN OTHERS THEN v_user_id := NULL; END;
    ELSIF v_conv.owner_kind = 'entity' THEN
      v_entity_type := v_match[1];
      v_entity_id   := COALESCE(v_match[2], '');
    END IF;

    INSERT INTO public.storage_object_ownership
      (bucket_id, object_name, owner_kind, organization_id, owner_user_id,
       entity_type, entity_id, module, convention_id, is_legacy_path, needs_review)
    VALUES
      (p_bucket, p_name, v_conv.owner_kind, v_org_id, v_user_id,
       v_entity_type, v_entity_id, v_conv.module, v_conv.id, v_conv.is_legacy, FALSE)
    ON CONFLICT (bucket_id, object_name) DO UPDATE SET
      owner_kind      = EXCLUDED.owner_kind,
      organization_id = EXCLUDED.organization_id,
      owner_user_id   = EXCLUDED.owner_user_id,
      entity_type     = EXCLUDED.entity_type,
      entity_id       = EXCLUDED.entity_id,
      module          = EXCLUDED.module,
      convention_id   = EXCLUDED.convention_id,
      is_legacy_path  = EXCLUDED.is_legacy_path,
      needs_review    = FALSE,
      inferred_at     = now();
    RETURN;
  END LOOP;

  IF NOT v_matched THEN
    INSERT INTO public.storage_object_ownership
      (bucket_id, object_name, owner_kind, module, is_legacy_path, needs_review)
    VALUES (p_bucket, p_name, 'unknown', 'core', FALSE, TRUE)
    ON CONFLICT (bucket_id, object_name) DO UPDATE SET
      needs_review = TRUE,
      inferred_at  = now();
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.register_storage_object(TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_storage_object(TEXT, TEXT, UUID) TO service_role, authenticated;

-- 5. Triggers on storage.objects
CREATE OR REPLACE FUNCTION public.tg_storage_objects_register()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.register_storage_object(NEW.bucket_id, NEW.name, NEW.owner);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'register_storage_object failed for %/%: %',
    NEW.bucket_id, NEW.name, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_storage_objects_register ON storage.objects;
CREATE TRIGGER trg_storage_objects_register
  AFTER INSERT ON storage.objects
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_storage_objects_register();

CREATE OR REPLACE FUNCTION public.tg_storage_objects_unregister()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.storage_object_ownership
    WHERE bucket_id = OLD.bucket_id AND object_name = OLD.name;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_storage_objects_unregister ON storage.objects;
CREATE TRIGGER trg_storage_objects_unregister
  AFTER DELETE ON storage.objects
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_storage_objects_unregister();

-- 6. One-time backfill
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT bucket_id, name FROM storage.objects LOOP
    PERFORM public.register_storage_object(r.bucket_id, r.name, NULL);
  END LOOP;
END;
$$;

-- 7. Orphan inventory view
CREATE OR REPLACE VIEW public.storage_orphan_inventory AS
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
    WHEN soo.owner_kind = 'user'
      THEN NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = soo.owner_user_id)
    WHEN soo.owner_kind = 'unknown'
      THEN TRUE
    ELSE FALSE
  END AS is_orphan
FROM public.storage_object_ownership soo;

GRANT SELECT ON public.storage_orphan_inventory TO authenticated;
GRANT ALL    ON public.storage_orphan_inventory TO service_role;

COMMENT ON TABLE public.storage_bucket_conventions IS
  'Phase 1 of storage governance: data-driven path conventions per bucket.';
COMMENT ON TABLE public.storage_object_ownership IS
  'First-class ownership row for every object in storage.objects.';
COMMENT ON VIEW  public.storage_orphan_inventory IS
  'Read-only orphan report: ownership rows whose owner no longer exists, plus paths that did not match any convention.';
