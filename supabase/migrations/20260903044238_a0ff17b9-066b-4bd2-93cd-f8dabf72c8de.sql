ALTER TABLE public.document_template_ast
  ALTER COLUMN template_id DROP NOT NULL,
  ALTER COLUMN organization_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ALTER COLUMN is_default SET DEFAULT false,
  ALTER COLUMN is_default SET NOT NULL;

ALTER TABLE public.document_template_ast
  DROP CONSTRAINT IF EXISTS tpl_ast_scope_target_ck;
ALTER TABLE public.document_template_ast
  ADD CONSTRAINT tpl_ast_scope_target_ck CHECK (
    scope IS NULL
    OR (scope = 'system'       AND organization_id IS NULL AND branch_id IS NULL)
    OR (scope = 'tenant'       AND organization_id IS NULL AND branch_id IS NULL)
    OR (scope = 'organization' AND organization_id IS NOT NULL AND branch_id IS NULL)
    OR (scope = 'branch'       AND organization_id IS NOT NULL AND branch_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS document_template_ast_kind_scope_idx
  ON public.document_template_ast (kind_code, scope, organization_id, branch_id);
CREATE UNIQUE INDEX IF NOT EXISTS document_template_ast_default_uk
  ON public.document_template_ast (kind_code, scope,
    COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_default;

DROP POLICY IF EXISTS "tpl_ast readable" ON public.document_template_ast;
CREATE POLICY "tpl_ast readable"
  ON public.document_template_ast FOR SELECT TO authenticated
  USING (
    scope IN ('system','tenant')
    OR (organization_id IS NOT NULL AND organization_id IN (SELECT public.get_user_organizations(auth.uid())))
  );