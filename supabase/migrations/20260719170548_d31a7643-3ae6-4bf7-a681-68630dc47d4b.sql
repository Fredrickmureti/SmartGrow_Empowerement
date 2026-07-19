
-- ============================================================================
-- Wave B3 — Document artifacts (immutable rendered documents). ADR-0084.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.document_artifacts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  business_id           uuid NOT NULL,
  branch_id             uuid,

  document_type         text NOT NULL,
  document_id           uuid NOT NULL,
  document_number       text,
  intent                text,
  version               integer NOT NULL DEFAULT 1,

  template_id           uuid,
  template_version      integer,
  policy_id             uuid,

  storage_bucket        text NOT NULL DEFAULT 'document-artifacts',
  storage_path          text NOT NULL,
  mime_type             text NOT NULL DEFAULT 'application/pdf',
  byte_size             bigint NOT NULL,
  content_sha256        text NOT NULL,
  page_count            integer,

  render_mode           text NOT NULL DEFAULT 'pdf',
  paper_format          text NOT NULL DEFAULT 'a4',
  copies                integer NOT NULL DEFAULT 1,

  rendered_by           uuid,
  rendered_via          text NOT NULL DEFAULT 'edge_function',
  regeneration_reason   text,
  supersedes_id         uuid REFERENCES public.document_artifacts(id) ON DELETE SET NULL,

  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT document_artifacts_render_mode_chk
    CHECK (render_mode IN ('pdf','zpl','escpos','html','png')),
  CONSTRAINT document_artifacts_sha_chk
    CHECK (length(content_sha256) = 64),
  CONSTRAINT document_artifacts_bytes_chk
    CHECK (byte_size > 0),
  CONSTRAINT document_artifacts_version_chk
    CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS document_artifacts_doc_idx
  ON public.document_artifacts (business_id, document_type, document_id, version DESC);
CREATE INDEX IF NOT EXISTS document_artifacts_org_created_idx
  ON public.document_artifacts (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS document_artifacts_sha_idx
  ON public.document_artifacts (business_id, content_sha256);

GRANT SELECT ON public.document_artifacts TO authenticated;
GRANT ALL    ON public.document_artifacts TO service_role;

ALTER TABLE public.document_artifacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business members read artifacts"
  ON public.document_artifacts
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id     = auth.uid()
        AND uba.business_id = document_artifacts.business_id
    )
  );

CREATE OR REPLACE FUNCTION public.document_artifacts_latest(
  p_business_id  uuid,
  p_document_type text,
  p_document_id   uuid
)
RETURNS SETOF public.document_artifacts
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT *
  FROM public.document_artifacts
  WHERE business_id   = p_business_id
    AND document_type = p_document_type
    AND document_id   = p_document_id
  ORDER BY version DESC, created_at DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.document_artifacts_latest(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.document_artifacts_latest(uuid,text,uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.document_artifacts_set_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.version IS NULL OR NEW.version = 1 THEN
    SELECT COALESCE(MAX(version), 0) + 1
      INTO NEW.version
      FROM public.document_artifacts
     WHERE business_id   = NEW.business_id
       AND document_type = NEW.document_type
       AND document_id   = NEW.document_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS document_artifacts_set_version_trg ON public.document_artifacts;
CREATE TRIGGER document_artifacts_set_version_trg
BEFORE INSERT ON public.document_artifacts
FOR EACH ROW
EXECUTE FUNCTION public.document_artifacts_set_version();

-- Storage RLS: business members can read files whose first path segment is
-- their business_id. Writes remain service_role-only.
DROP POLICY IF EXISTS "document-artifacts business read" ON storage.objects;
CREATE POLICY "document-artifacts business read"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'document-artifacts'
    AND EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
        AND uba.business_id::text = split_part(storage.objects.name, '/', 1)
    )
  );
