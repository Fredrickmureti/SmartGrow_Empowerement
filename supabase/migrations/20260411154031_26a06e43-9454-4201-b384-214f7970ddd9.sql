
CREATE TABLE public.vendor_statements (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  statement_date DATE NOT NULL DEFAULT CURRENT_DATE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  opening_balance NUMERIC NOT NULL DEFAULT 0,
  total_billed NUMERIC NOT NULL DEFAULT 0,
  total_payments NUMERIC NOT NULL DEFAULT 0,
  closing_balance NUMERIC NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  sent_to TEXT,
  pdf_url TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.vendor_statements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "vendor_statements_select_perm" ON public.vendor_statements FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'contacts', 'read'));
CREATE POLICY "vendor_statements_insert_perm" ON public.vendor_statements FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'contacts', 'create'));
CREATE POLICY "vendor_statements_update_perm" ON public.vendor_statements FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'contacts', 'write'));
CREATE POLICY "vendor_statements_delete_perm" ON public.vendor_statements FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'contacts', 'delete'));

CREATE INDEX idx_vendor_statements_org_business ON public.vendor_statements(organization_id, business_id);
CREATE INDEX idx_vendor_statements_contact ON public.vendor_statements(contact_id);
