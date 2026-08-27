CREATE TABLE public.consolidation_intercompany_partners (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.consolidation_groups(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  counterparty_business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consolidation_intercompany_partners_period_ck
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT consolidation_intercompany_partners_not_self_ck
    CHECK (counterparty_business_id <> business_id)
);

CREATE INDEX consolidation_intercompany_partners_group_idx
  ON public.consolidation_intercompany_partners (group_id, business_id);
CREATE INDEX consolidation_intercompany_partners_contact_idx
  ON public.consolidation_intercompany_partners (contact_id);
CREATE INDEX consolidation_intercompany_partners_counterparty_idx
  ON public.consolidation_intercompany_partners (counterparty_business_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.consolidation_intercompany_partners TO authenticated;
GRANT ALL ON public.consolidation_intercompany_partners TO service_role;

ALTER TABLE public.consolidation_intercompany_partners ENABLE ROW LEVEL SECURITY;

CREATE POLICY consolidation_intercompany_partners_select
  ON public.consolidation_intercompany_partners
  FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id)
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_can_access_business(auth.uid(), counterparty_business_id)
    AND EXISTS (
      SELECT 1 FROM public.consolidation_groups g
       WHERE g.id = consolidation_intercompany_partners.group_id
         AND public.user_can_access_business(auth.uid(), g.parent_business_id)
    )
  );

CREATE POLICY consolidation_intercompany_partners_write
  ON public.consolidation_intercompany_partners
  FOR ALL TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_can_access_business(auth.uid(), counterparty_business_id)
    AND EXISTS (
      SELECT 1 FROM public.consolidation_groups g
       WHERE g.id = consolidation_intercompany_partners.group_id
         AND public.user_can_access_business(auth.uid(), g.parent_business_id)
    )
    AND (
      public.has_org_role(auth.uid(), organization_id, 'owner'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'admin'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::app_role)
    )
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_can_access_business(auth.uid(), counterparty_business_id)
    AND EXISTS (
      SELECT 1 FROM public.consolidation_groups g
       WHERE g.id = consolidation_intercompany_partners.group_id
         AND public.user_can_access_business(auth.uid(), g.parent_business_id)
    )
    AND (
      public.has_org_role(auth.uid(), organization_id, 'owner'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'admin'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::app_role)
    )
  );
