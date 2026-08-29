-- ============================================================
-- Baseline 3: Document & rendering infrastructure
-- ============================================================

-- ---------- document_records ----------
CREATE TABLE public.document_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  kind_code text NOT NULL,
  source_module text NOT NULL,
  source_doc_type text NOT NULL,
  source_doc_id uuid NOT NULL,
  party_kind text,
  party_id uuid,
  currency text,
  locale text,
  document_number text,
  document_date date,
  snapshot jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, kind_code, source_doc_type, source_doc_id)
);
GRANT SELECT, INSERT, UPDATE ON public.document_records TO authenticated;
GRANT ALL ON public.document_records TO service_role;
ALTER TABLE public.document_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "document_records_read" ON public.document_records FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE POLICY "document_records_write" ON public.document_records FOR INSERT TO authenticated
  WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE POLICY "document_records_update" ON public.document_records FOR UPDATE TO authenticated
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE INDEX idx_document_records_source ON public.document_records (source_doc_type, source_doc_id);
CREATE INDEX idx_document_records_business ON public.document_records (business_id, kind_code);

-- ---------- document_theme ----------
CREATE TABLE public.document_theme (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  tokens jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_theme TO authenticated;
GRANT ALL ON public.document_theme TO service_role;
ALTER TABLE public.document_theme ENABLE ROW LEVEL SECURITY;
CREATE POLICY "document_theme_all" ON public.document_theme FOR ALL TO authenticated
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
  WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

-- ---------- document_header_footer ----------
CREATE TABLE public.document_header_footer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'header',
  ast jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_header_footer TO authenticated;
GRANT ALL ON public.document_header_footer TO service_role;
ALTER TABLE public.document_header_footer ENABLE ROW LEVEL SECURITY;
CREATE POLICY "document_header_footer_all" ON public.document_header_footer FOR ALL TO authenticated
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
  WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

-- ---------- document_templates ----------
CREATE TABLE public.document_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  template_type text NOT NULL,
  name text NOT NULL,
  description text,
  version integer NOT NULL DEFAULT 1,
  paper_format text,
  ast jsonb NOT NULL DEFAULT '[]'::jsonb,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  theme_id uuid REFERENCES public.document_theme(id) ON DELETE SET NULL,
  header_id uuid REFERENCES public.document_header_footer(id) ON DELETE SET NULL,
  footer_id uuid REFERENCES public.document_header_footer(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_templates TO authenticated;
GRANT ALL ON public.document_templates TO service_role;
ALTER TABLE public.document_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "document_templates_all" ON public.document_templates FOR ALL TO authenticated
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
  WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE INDEX idx_document_templates_lookup
  ON public.document_templates (organization_id, business_id, template_type, is_active, is_default);

-- ---------- document_template_ast ----------
CREATE TABLE public.document_template_ast (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.document_templates(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  ast jsonb NOT NULL DEFAULT '[]'::jsonb,
  published_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_template_ast TO authenticated;
GRANT ALL ON public.document_template_ast TO service_role;
ALTER TABLE public.document_template_ast ENABLE ROW LEVEL SECURITY;
CREATE POLICY "document_template_ast_all" ON public.document_template_ast FOR ALL TO authenticated
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
  WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

-- ---------- document_artifacts ----------
CREATE TABLE public.document_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  document_type text NOT NULL,
  document_id uuid,
  document_record_id uuid REFERENCES public.document_records(id) ON DELETE SET NULL,
  document_number text,
  intent text,
  template_id uuid,
  template_version integer,
  policy_id uuid,
  storage_bucket text NOT NULL,
  storage_path text NOT NULL,
  mime_type text,
  byte_size bigint,
  content_sha256 text,
  render_mode text,
  paper_format text,
  copies integer,
  version integer NOT NULL DEFAULT 1,
  supersedes_id uuid REFERENCES public.document_artifacts(id) ON DELETE SET NULL,
  superseded_by uuid REFERENCES public.document_artifacts(id) ON DELETE SET NULL,
  rendered_by uuid,
  rendered_via text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.document_artifacts TO authenticated;
GRANT ALL ON public.document_artifacts TO service_role;
ALTER TABLE public.document_artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "document_artifacts_read" ON public.document_artifacts FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE INDEX idx_document_artifacts_doc ON public.document_artifacts (document_type, document_id, version DESC);
CREATE INDEX idx_document_artifacts_business ON public.document_artifacts (business_id, content_sha256);

-- ---------- document_print_policies ----------
CREATE TABLE public.document_print_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  document_type text NOT NULL,
  paper_format text,
  render_mode text,
  trigger text,
  role_code text,
  copies integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_print_policies TO authenticated;
GRANT ALL ON public.document_print_policies TO service_role;
ALTER TABLE public.document_print_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "document_print_policies_all" ON public.document_print_policies FOR ALL TO authenticated
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
  WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE INDEX idx_document_print_policies_lookup
  ON public.document_print_policies (business_id, document_type, branch_id);

-- ---------- document_emails ----------
CREATE TABLE public.document_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  document_type text NOT NULL,
  document_id uuid NOT NULL,
  document_record_id uuid REFERENCES public.document_records(id) ON DELETE SET NULL,
  recipient_email text NOT NULL,
  cc_emails text[],
  subject text,
  body text,
  status text NOT NULL DEFAULT 'queued',
  error_message text,
  provider_message_id text,
  sent_by uuid,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.document_emails TO authenticated;
GRANT ALL ON public.document_emails TO service_role;
ALTER TABLE public.document_emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY "document_emails_read" ON public.document_emails FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE INDEX idx_document_emails_doc ON public.document_emails (document_type, document_id, created_at DESC);

-- ---------- email_templates ----------
CREATE TABLE public.email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  template_key text NOT NULL,
  name text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_templates TO authenticated;
GRANT ALL ON public.email_templates TO service_role;
ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "email_templates_all" ON public.email_templates FOR ALL TO authenticated
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
  WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE INDEX idx_email_templates_key ON public.email_templates (organization_id, template_key);

-- ---------- format_registry (shared catalogue) ----------
CREATE TABLE public.format_registry (
  format text PRIMARY KEY,
  label text NOT NULL,
  mime text NOT NULL,
  ext text NOT NULL,
  role_hint text,
  writer text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.format_registry TO authenticated;
GRANT ALL ON public.format_registry TO service_role;
ALTER TABLE public.format_registry ENABLE ROW LEVEL SECURITY;
CREATE POLICY "format_registry_read" ON public.format_registry FOR SELECT TO authenticated USING (true);

-- ---------- media_profiles ----------
CREATE TABLE public.media_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  width_mm numeric NOT NULL,
  height_mm numeric NOT NULL,
  dpi integer,
  active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_profiles TO authenticated;
GRANT ALL ON public.media_profiles TO service_role;
ALTER TABLE public.media_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "media_profiles_all" ON public.media_profiles FOR ALL TO authenticated
  USING (org_id IN (SELECT public.get_user_organizations(auth.uid())))
  WITH CHECK (org_id IN (SELECT public.get_user_organizations(auth.uid())));

-- ---------- output_dispatch_log ----------
CREATE TABLE public.output_dispatch_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  document_record_id uuid REFERENCES public.document_records(id) ON DELETE SET NULL,
  artifact_id uuid REFERENCES public.document_artifacts(id) ON DELETE SET NULL,
  intent text,
  disposition text,
  medium text,
  destination text,
  status text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.output_dispatch_log TO authenticated;
GRANT ALL ON public.output_dispatch_log TO service_role;
ALTER TABLE public.output_dispatch_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "output_dispatch_log_read" ON public.output_dispatch_log FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

-- ---------- updated_at triggers ----------
CREATE TRIGGER trg_document_records_updated_at BEFORE UPDATE ON public.document_records
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_document_theme_updated_at BEFORE UPDATE ON public.document_theme
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_document_header_footer_updated_at BEFORE UPDATE ON public.document_header_footer
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_document_templates_updated_at BEFORE UPDATE ON public.document_templates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_document_template_ast_updated_at BEFORE UPDATE ON public.document_template_ast
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_document_print_policies_updated_at BEFORE UPDATE ON public.document_print_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_email_templates_updated_at BEFORE UPDATE ON public.email_templates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_media_profiles_updated_at BEFORE UPDATE ON public.media_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------- ensure_document_record ----------
CREATE OR REPLACE FUNCTION public.ensure_document_record(
  p_kind_code text,
  p_organization_id uuid,
  p_source_module text,
  p_source_doc_type text,
  p_source_doc_id uuid,
  p_business_id uuid DEFAULT NULL,
  p_branch_id uuid DEFAULT NULL,
  p_party_kind text DEFAULT NULL,
  p_party_id uuid DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_locale text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_document_number text DEFAULT NULL,
  p_document_date date DEFAULT NULL,
  p_snapshot jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_organization_id IS NULL
     OR p_organization_id NOT IN (SELECT public.get_user_organizations(auth.uid())) THEN
    RAISE EXCEPTION 'not_authorized_for_organization' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.document_records (
    organization_id, business_id, branch_id, kind_code, source_module,
    source_doc_type, source_doc_id, party_kind, party_id, currency, locale,
    document_number, document_date, snapshot, metadata, created_by
  ) VALUES (
    p_organization_id, p_business_id, p_branch_id, p_kind_code, p_source_module,
    p_source_doc_type, p_source_doc_id, p_party_kind, p_party_id, p_currency, p_locale,
    p_document_number, p_document_date, p_snapshot, COALESCE(p_metadata, '{}'::jsonb), auth.uid()
  )
  ON CONFLICT (organization_id, kind_code, source_doc_type, source_doc_id)
  DO UPDATE SET
    document_number = COALESCE(EXCLUDED.document_number, public.document_records.document_number),
    document_date   = COALESCE(EXCLUDED.document_date, public.document_records.document_date),
    currency        = COALESCE(EXCLUDED.currency, public.document_records.currency),
    locale          = COALESCE(EXCLUDED.locale, public.document_records.locale),
    branch_id       = COALESCE(EXCLUDED.branch_id, public.document_records.branch_id),
    party_kind      = COALESCE(EXCLUDED.party_kind, public.document_records.party_kind),
    party_id        = COALESCE(EXCLUDED.party_id, public.document_records.party_id),
    snapshot        = COALESCE(EXCLUDED.snapshot, public.document_records.snapshot),
    metadata        = public.document_records.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
    updated_at      = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.ensure_document_record(text, uuid, text, text, uuid, uuid, uuid, text, uuid, text, text, jsonb, text, date, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_document_record(text, uuid, text, text, uuid, uuid, uuid, text, uuid, text, text, jsonb, text, date, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ensure_document_record(text, uuid, text, text, uuid, uuid, uuid, text, uuid, text, text, jsonb, text, date, jsonb) TO authenticated, service_role;