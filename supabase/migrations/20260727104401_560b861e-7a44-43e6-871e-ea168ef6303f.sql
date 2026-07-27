
-- Wave 2: canonical AST template registry.

-- Reusable themes (colors, fonts, spacing).
CREATE TABLE IF NOT EXISTS public.document_theme (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  label text NOT NULL,
  tokens jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { colors, fonts, spacing, rules }
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS document_theme_org_idx ON public.document_theme (organization_id);

GRANT SELECT ON public.document_theme TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.document_theme TO authenticated;
GRANT ALL ON public.document_theme TO service_role;
ALTER TABLE public.document_theme ENABLE ROW LEVEL SECURITY;

CREATE POLICY "themes readable"
  ON public.document_theme FOR SELECT
  USING (is_system OR (organization_id IS NOT NULL AND public.is_org_member(auth.uid(), organization_id)));

CREATE POLICY "themes writable by org"
  ON public.document_theme FOR INSERT TO authenticated
  WITH CHECK (organization_id IS NOT NULL AND public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "themes updatable by org"
  ON public.document_theme FOR UPDATE TO authenticated
  USING (organization_id IS NOT NULL AND public.is_org_member(auth.uid(), organization_id))
  WITH CHECK (organization_id IS NOT NULL AND public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "themes deletable by org"
  ON public.document_theme FOR DELETE TO authenticated
  USING (organization_id IS NOT NULL AND public.is_org_member(auth.uid(), organization_id));


-- Reusable headers / footers (also AST fragments, but composable across templates).
CREATE TABLE IF NOT EXISTS public.document_header_footer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('header','footer')),
  code text NOT NULL,
  label text NOT NULL,
  ast jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, kind, code)
);
CREATE INDEX IF NOT EXISTS document_header_footer_org_idx ON public.document_header_footer (organization_id, kind);

GRANT SELECT ON public.document_header_footer TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.document_header_footer TO authenticated;
GRANT ALL ON public.document_header_footer TO service_role;
ALTER TABLE public.document_header_footer ENABLE ROW LEVEL SECURITY;

CREATE POLICY "header_footer readable"
  ON public.document_header_footer FOR SELECT
  USING (is_system OR (organization_id IS NOT NULL AND public.is_org_member(auth.uid(), organization_id)));

CREATE POLICY "header_footer writable by org"
  ON public.document_header_footer FOR INSERT TO authenticated
  WITH CHECK (organization_id IS NOT NULL AND public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "header_footer updatable by org"
  ON public.document_header_footer FOR UPDATE TO authenticated
  USING (organization_id IS NOT NULL AND public.is_org_member(auth.uid(), organization_id))
  WITH CHECK (organization_id IS NOT NULL AND public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "header_footer deletable by org"
  ON public.document_header_footer FOR DELETE TO authenticated
  USING (organization_id IS NOT NULL AND public.is_org_member(auth.uid(), organization_id));


-- Canonical template registry: one row per (kind, scope, scope target, version).
CREATE TABLE IF NOT EXISTS public.document_template_ast (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind_code text NOT NULL REFERENCES public.document_kinds(code),
  scope text NOT NULL CHECK (scope IN ('system','tenant','organization','branch')),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  version int NOT NULL DEFAULT 1,
  label text NOT NULL,
  ast jsonb NOT NULL DEFAULT '{"blocks":[]}'::jsonb,
  theme_id uuid REFERENCES public.document_theme(id) ON DELETE SET NULL,
  header_id uuid REFERENCES public.document_header_footer(id) ON DELETE SET NULL,
  footer_id uuid REFERENCES public.document_header_footer(id) ON DELETE SET NULL,
  media_class text,                   -- override kind default when set
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tpl_ast_scope_target_ck CHECK (
    (scope = 'system'       AND organization_id IS NULL AND branch_id IS NULL)
    OR (scope = 'tenant'    AND organization_id IS NULL AND branch_id IS NULL)
    OR (scope = 'organization' AND organization_id IS NOT NULL AND branch_id IS NULL)
    OR (scope = 'branch'    AND organization_id IS NOT NULL AND branch_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS document_template_ast_kind_scope_idx
  ON public.document_template_ast (kind_code, scope, organization_id, branch_id);
CREATE UNIQUE INDEX IF NOT EXISTS document_template_ast_default_uk
  ON public.document_template_ast (kind_code, scope, COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_default;

GRANT SELECT ON public.document_template_ast TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.document_template_ast TO authenticated;
GRANT ALL ON public.document_template_ast TO service_role;
ALTER TABLE public.document_template_ast ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tpl_ast readable"
  ON public.document_template_ast FOR SELECT
  USING (
    scope = 'system'
    OR (organization_id IS NOT NULL AND public.is_org_member(auth.uid(), organization_id))
  );

CREATE POLICY "tpl_ast insert by org"
  ON public.document_template_ast FOR INSERT TO authenticated
  WITH CHECK (
    scope IN ('organization','branch')
    AND organization_id IS NOT NULL
    AND public.is_org_member(auth.uid(), organization_id)
  );

CREATE POLICY "tpl_ast update by org"
  ON public.document_template_ast FOR UPDATE TO authenticated
  USING (
    scope IN ('organization','branch')
    AND organization_id IS NOT NULL
    AND public.is_org_member(auth.uid(), organization_id)
  )
  WITH CHECK (
    scope IN ('organization','branch')
    AND organization_id IS NOT NULL
    AND public.is_org_member(auth.uid(), organization_id)
  );

CREATE POLICY "tpl_ast delete by org"
  ON public.document_template_ast FOR DELETE TO authenticated
  USING (
    scope IN ('organization','branch')
    AND organization_id IS NOT NULL
    AND public.is_org_member(auth.uid(), organization_id)
  );

-- Timestamp triggers (reuse documents_touch_updated_at from Wave 1).
DROP TRIGGER IF EXISTS document_theme_touch_updated_at ON public.document_theme;
CREATE TRIGGER document_theme_touch_updated_at
  BEFORE UPDATE ON public.document_theme
  FOR EACH ROW EXECUTE FUNCTION public.documents_touch_updated_at();

DROP TRIGGER IF EXISTS document_header_footer_touch_updated_at ON public.document_header_footer;
CREATE TRIGGER document_header_footer_touch_updated_at
  BEFORE UPDATE ON public.document_header_footer
  FOR EACH ROW EXECUTE FUNCTION public.documents_touch_updated_at();

DROP TRIGGER IF EXISTS document_template_ast_touch_updated_at ON public.document_template_ast;
CREATE TRIGGER document_template_ast_touch_updated_at
  BEFORE UPDATE ON public.document_template_ast
  FOR EACH ROW EXECUTE FUNCTION public.documents_touch_updated_at();

-- Seed: one system-default AST template per registered kind.
-- The AST here is intentionally minimal — a spine every renderer can consume;
-- richer defaults (per-domain layout blocks) ship as system-scope updates in
-- Wave 3 alongside the renderer changes.
INSERT INTO public.document_template_ast (kind_code, scope, label, is_default, ast, media_class)
SELECT
  k.code,
  'system',
  'System default — ' || k.label,
  true,
  jsonb_build_object(
    'version', 1,
    'kind', k.code,
    'media_class', k.default_media_class,
    'blocks', jsonb_build_array(
      jsonb_build_object('type', 'header',  'variant', 'branded'),
      jsonb_build_object('type', 'party',   'role', COALESCE(
        CASE WHEN k.domain IN ('sales','pos','legal') THEN 'customer'
             WHEN k.domain = 'purchases' THEN 'vendor'
             WHEN k.domain IN ('hr','payroll') THEN 'employee'
             ELSE NULL END, NULL)),
      jsonb_build_object('type', 'meta',    'fields', jsonb_build_array('number','date','due_date','currency')),
      jsonb_build_object('type', 'table',   'preset', 'line_items'),
      jsonb_build_object('type', 'totals',  'preset', 'standard'),
      jsonb_build_object('type', 'notes',   'source', 'terms'),
      jsonb_build_object('type', 'footer',  'variant', 'branded')
    )
  ),
  k.default_media_class
FROM public.document_kinds k
WHERE NOT EXISTS (
  SELECT 1 FROM public.document_template_ast t
  WHERE t.kind_code = k.code AND t.scope = 'system' AND t.is_default
);
