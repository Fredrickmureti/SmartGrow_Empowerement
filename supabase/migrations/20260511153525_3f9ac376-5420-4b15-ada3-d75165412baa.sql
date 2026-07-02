
CREATE TABLE IF NOT EXISTS public.document_print_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid NULL,
  document_type text NOT NULL,
  paper_format text NOT NULL DEFAULT 'a4'
    CHECK (paper_format IN ('a4','letter','a5','80mm','58mm')),
  render_mode text NOT NULL DEFAULT 'pdf'
    CHECK (render_mode IN ('pdf','escpos','html')),
  printer_profile_id uuid NULL,
  auto_print boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL,
  updated_by uuid NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS document_print_policies_unique
  ON public.document_print_policies (business_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), document_type);

CREATE INDEX IF NOT EXISTS document_print_policies_lookup
  ON public.document_print_policies (business_id, document_type);

ALTER TABLE public.document_print_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dpp_select_members" ON public.document_print_policies;
CREATE POLICY "dpp_select_members"
ON public.document_print_policies FOR SELECT
USING (public.user_has_business_access(auth.uid(), business_id));

DROP POLICY IF EXISTS "dpp_write_admins" ON public.document_print_policies;
CREATE POLICY "dpp_write_admins"
ON public.document_print_policies FOR ALL
USING (
  public.user_has_business_access(auth.uid(), business_id)
  AND EXISTS (
    SELECT 1 FROM public.businesses b
    WHERE b.id = business_id
      AND (
        public.has_role(auth.uid(), b.organization_id, 'owner')
        OR public.has_role(auth.uid(), b.organization_id, 'admin')
        OR public.has_role(auth.uid(), b.organization_id, 'accountant')
      )
  )
)
WITH CHECK (
  public.user_has_business_access(auth.uid(), business_id)
  AND EXISTS (
    SELECT 1 FROM public.businesses b
    WHERE b.id = business_id
      AND (
        public.has_role(auth.uid(), b.organization_id, 'owner')
        OR public.has_role(auth.uid(), b.organization_id, 'admin')
        OR public.has_role(auth.uid(), b.organization_id, 'accountant')
      )
  )
);

DROP TRIGGER IF EXISTS trg_dpp_updated_at ON public.document_print_policies;
CREATE TRIGGER trg_dpp_updated_at
BEFORE UPDATE ON public.document_print_policies
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
