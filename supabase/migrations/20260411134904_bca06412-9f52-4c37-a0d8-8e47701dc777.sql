-- Create vendor_credit_notes table
CREATE TABLE public.vendor_credit_notes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  credit_note_number TEXT NOT NULL,
  vendor_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  bill_id UUID REFERENCES public.bills(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'applied', 'void')),
  credit_date DATE NOT NULL DEFAULT CURRENT_DATE,
  subtotal NUMERIC NOT NULL DEFAULT 0,
  tax_amount NUMERIC NOT NULL DEFAULT 0,
  total NUMERIC NOT NULL DEFAULT 0,
  amount_applied NUMERIC NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  notes TEXT,
  journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, credit_note_number)
);

-- Create vendor_credit_note_items table
CREATE TABLE public.vendor_credit_note_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  credit_note_id UUID NOT NULL REFERENCES public.vendor_credit_notes(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  quantity NUMERIC NOT NULL DEFAULT 1,
  unit_price NUMERIC NOT NULL DEFAULT 0,
  tax_rate NUMERIC NOT NULL DEFAULT 0,
  tax_amount NUMERIC NOT NULL DEFAULT 0,
  line_total NUMERIC NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Enable RLS
ALTER TABLE public.vendor_credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_credit_note_items ENABLE ROW LEVEL SECURITY;

-- RLS policies for vendor_credit_notes using module permissions
CREATE POLICY "vcn_select_perm" ON public.vendor_credit_notes FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'read'));

CREATE POLICY "vcn_insert_perm" ON public.vendor_credit_notes FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'create'));

CREATE POLICY "vcn_update_perm" ON public.vendor_credit_notes FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'write'));

CREATE POLICY "vcn_delete_perm" ON public.vendor_credit_notes FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'delete'));

-- RLS policies for vendor_credit_note_items (via parent join)
CREATE POLICY "vcni_select_perm" ON public.vendor_credit_note_items FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.vendor_credit_notes vcn
      WHERE vcn.id = credit_note_id
      AND public.user_has_module_permission(auth.uid(), vcn.organization_id, 'purchases', 'read')
    )
  );

CREATE POLICY "vcni_insert_perm" ON public.vendor_credit_note_items FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.vendor_credit_notes vcn
      WHERE vcn.id = credit_note_id
      AND public.user_has_module_permission(auth.uid(), vcn.organization_id, 'purchases', 'create')
    )
  );

CREATE POLICY "vcni_update_perm" ON public.vendor_credit_note_items FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.vendor_credit_notes vcn
      WHERE vcn.id = credit_note_id
      AND public.user_has_module_permission(auth.uid(), vcn.organization_id, 'purchases', 'write')
    )
  );

CREATE POLICY "vcni_delete_perm" ON public.vendor_credit_note_items FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.vendor_credit_notes vcn
      WHERE vcn.id = credit_note_id
      AND public.user_has_module_permission(auth.uid(), vcn.organization_id, 'purchases', 'delete')
    )
  );

-- Indexes
CREATE INDEX idx_vendor_credit_notes_org ON public.vendor_credit_notes(organization_id);
CREATE INDEX idx_vendor_credit_notes_vendor ON public.vendor_credit_notes(vendor_id);
CREATE INDEX idx_vendor_credit_notes_bill ON public.vendor_credit_notes(bill_id);
CREATE INDEX idx_vendor_credit_note_items_note ON public.vendor_credit_note_items(credit_note_id);

-- Trigger for updated_at
CREATE TRIGGER update_vendor_credit_notes_updated_at
  BEFORE UPDATE ON public.vendor_credit_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();