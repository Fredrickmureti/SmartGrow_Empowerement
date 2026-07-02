
-- Scanner Scope Policies — tenant default + per-user override
CREATE TABLE public.scanner_scope_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  user_id uuid NULL,
  mode text NOT NULL DEFAULT 'ambient' CHECK (mode IN ('ambient','scoped')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One tenant default per business
CREATE UNIQUE INDEX scanner_scope_policies_tenant_uniq
  ON public.scanner_scope_policies (business_id)
  WHERE user_id IS NULL;
-- One override per (business,user)
CREATE UNIQUE INDEX scanner_scope_policies_user_uniq
  ON public.scanner_scope_policies (business_id, user_id)
  WHERE user_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scanner_scope_policies TO authenticated;
GRANT ALL ON public.scanner_scope_policies TO service_role;

ALTER TABLE public.scanner_scope_policies ENABLE ROW LEVEL SECURITY;

-- Members of the business can read all policies for that business (they need the tenant default + their own override)
CREATE POLICY "members read scope policies"
ON public.scanner_scope_policies
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
      AND uba.business_id = scanner_scope_policies.business_id
  )
);

-- A user can upsert their own override
CREATE POLICY "user writes own override"
ON public.scanner_scope_policies
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
      AND uba.business_id = scanner_scope_policies.business_id
  )
);

CREATE POLICY "user updates own override"
ON public.scanner_scope_policies
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE POLICY "user deletes own override"
ON public.scanner_scope_policies
FOR DELETE
TO authenticated
USING (user_id = auth.uid());

-- Tenant default: any admin/owner role on user_business_access can manage
CREATE POLICY "admins manage tenant default"
ON public.scanner_scope_policies
FOR ALL
TO authenticated
USING (
  user_id IS NULL
  AND EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
      AND uba.business_id = scanner_scope_policies.business_id
      AND uba.role IN ('owner','admin')
  )
)
WITH CHECK (
  user_id IS NULL
  AND EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
      AND uba.business_id = scanner_scope_policies.business_id
      AND uba.role IN ('owner','admin')
  )
);

CREATE TRIGGER scanner_scope_policies_set_updated_at
BEFORE UPDATE ON public.scanner_scope_policies
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
