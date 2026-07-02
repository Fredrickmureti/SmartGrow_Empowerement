-- =============================================
-- PHASE 6: AUDIT TRAIL & CREDIT NOTES
-- =============================================

-- Audit logs table
CREATE TABLE public.audit_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID,
  
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'view', 'export', 'login', 'logout')),
  entity_type TEXT NOT NULL, -- 'invoice', 'expense', 'contact', etc.
  entity_id UUID,
  entity_name TEXT, -- Human readable identifier
  
  old_values JSONB,
  new_values JSONB,
  changes_summary TEXT, -- Brief description of what changed
  
  ip_address TEXT,
  user_agent TEXT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credit notes
DO $$ BEGIN
  CREATE TYPE credit_note_status AS ENUM ('draft', 'issued', 'applied', 'void');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE public.credit_notes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  
  credit_note_number TEXT NOT NULL,
  status credit_note_status NOT NULL DEFAULT 'draft',
  
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  
  subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  amount_applied NUMERIC(12, 2) DEFAULT 0,
  
  currency TEXT DEFAULT 'USD',
  reason TEXT NOT NULL,
  notes TEXT,
  
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.credit_note_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  credit_note_id UUID NOT NULL REFERENCES public.credit_notes(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  
  description TEXT NOT NULL,
  quantity NUMERIC(10, 2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12, 2) NOT NULL,
  tax_rate NUMERIC(5, 2) DEFAULT 0,
  tax_amount NUMERIC(12, 2) DEFAULT 0,
  line_total NUMERIC(12, 2) NOT NULL,
  
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credit note applications (when credit is applied to invoices)
CREATE TABLE public.credit_note_applications (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  credit_note_id UUID NOT NULL REFERENCES public.credit_notes(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  amount NUMERIC(12, 2) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by UUID,
  notes TEXT
);

-- Function to get next credit note number
CREATE OR REPLACE FUNCTION public.get_next_credit_note_number(_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    next_num INTEGER;
    year_prefix TEXT;
    prefix TEXT;
BEGIN
    year_prefix := to_char(CURRENT_DATE, 'YYYY');
    
    SELECT COALESCE(credit_note_prefix, 'CN') INTO prefix
    FROM public.organizations WHERE id = _org_id;
    
    SELECT COALESCE(MAX(
        CAST(NULLIF(regexp_replace(credit_note_number, '[^0-9]', '', 'g'), '') AS INTEGER)
    ), 0) + 1
    INTO next_num
    FROM public.credit_notes
    WHERE organization_id = _org_id
    AND credit_note_number LIKE prefix || '-' || year_prefix || '-%';
    
    RETURN prefix || '-' || year_prefix || '-' || LPAD(next_num::TEXT, 4, '0');
END;
$$;

-- Enable RLS
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_note_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_note_applications ENABLE ROW LEVEL SECURITY;

-- RLS Policies for audit_logs (read only for members, admins can see all)
CREATE POLICY "Admins can view audit logs" ON public.audit_logs
  FOR SELECT USING (
    organization_id IN (SELECT get_user_organizations(auth.uid()))
    AND (
      has_role(auth.uid(), organization_id, 'owner') 
      OR has_role(auth.uid(), organization_id, 'admin')
    )
  );

CREATE POLICY "System can create audit logs" ON public.audit_logs
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- RLS Policies for credit_notes
CREATE POLICY "Users can view credit notes in their orgs" ON public.credit_notes
  FOR SELECT USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create credit notes in their orgs" ON public.credit_notes
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update credit notes in their orgs" ON public.credit_notes
  FOR UPDATE USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete draft credit notes" ON public.credit_notes
  FOR DELETE USING (organization_id IN (SELECT get_user_organizations(auth.uid())) AND status = 'draft');

-- RLS Policies for credit_note_items
CREATE POLICY "Users can view credit note items" ON public.credit_note_items
  FOR SELECT USING (credit_note_id IN (
    SELECT id FROM public.credit_notes WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

CREATE POLICY "Users can manage credit note items" ON public.credit_note_items
  FOR ALL USING (credit_note_id IN (
    SELECT id FROM public.credit_notes WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

-- RLS Policies for credit_note_applications
CREATE POLICY "Users can view credit applications" ON public.credit_note_applications
  FOR SELECT USING (credit_note_id IN (
    SELECT id FROM public.credit_notes WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

CREATE POLICY "Users can create credit applications" ON public.credit_note_applications
  FOR INSERT WITH CHECK (credit_note_id IN (
    SELECT id FROM public.credit_notes WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

-- Trigger for updated_at
CREATE TRIGGER update_credit_notes_updated_at
  BEFORE UPDATE ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Create index on audit_logs for performance
CREATE INDEX idx_audit_logs_org_created ON public.audit_logs (organization_id, created_at DESC);
CREATE INDEX idx_audit_logs_entity ON public.audit_logs (entity_type, entity_id);