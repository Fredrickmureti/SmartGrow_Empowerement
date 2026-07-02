
-- Phase 4: Vendor Portal

-- 1. Add portal_user_id to contacts (links vendor to auth user)
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS portal_user_id uuid;

-- 2. Create vendor_portal_invitations table
CREATE TABLE public.vendor_portal_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  email text NOT NULL,
  token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired')),
  invited_by uuid REFERENCES auth.users(id),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS for vendor_portal_invitations
ALTER TABLE public.vendor_portal_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view portal invitations"
  ON public.vendor_portal_invitations FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur 
      WHERE ur.user_id = auth.uid() AND ur.organization_id = vendor_portal_invitations.organization_id
    )
  );

CREATE POLICY "Admins can create portal invitations"
  ON public.vendor_portal_invitations FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles ur 
      WHERE ur.user_id = auth.uid() 
        AND ur.organization_id = vendor_portal_invitations.organization_id
        AND ur.role IN ('owner', 'admin', 'super_admin')
    )
  );

CREATE POLICY "Admins can update portal invitations"
  ON public.vendor_portal_invitations FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur 
      WHERE ur.user_id = auth.uid() 
        AND ur.organization_id = vendor_portal_invitations.organization_id
        AND ur.role IN ('owner', 'admin', 'super_admin')
    )
  );

-- 3. Create vendor_portal_access view-like RLS policies
-- Vendors can see their own POs
CREATE POLICY "Vendor portal users can view their POs"
  ON public.purchase_orders FOR SELECT
  TO authenticated
  USING (
    vendor_id IN (
      SELECT c.id FROM public.contacts c WHERE c.portal_user_id = auth.uid()
    )
  );

-- Vendors can see their own RFQ participation
CREATE POLICY "Vendor portal users can view their RFQs"
  ON public.rfq_vendors FOR SELECT
  TO authenticated
  USING (
    vendor_id IN (
      SELECT c.id FROM public.contacts c WHERE c.portal_user_id = auth.uid()
    )
  );

-- Vendors can update their RFQ responses
CREATE POLICY "Vendor portal users can update their RFQ responses"
  ON public.rfq_vendors FOR UPDATE
  TO authenticated
  USING (
    vendor_id IN (
      SELECT c.id FROM public.contacts c WHERE c.portal_user_id = auth.uid()
    )
  );

-- Vendors can view RFQ items for RFQs they're invited to
CREATE POLICY "Vendor portal users can view RFQ items"
  ON public.rfq_items FOR SELECT
  TO authenticated
  USING (
    rfq_id IN (
      SELECT rv.rfq_id FROM public.rfq_vendors rv
      WHERE rv.vendor_id IN (
        SELECT c.id FROM public.contacts c WHERE c.portal_user_id = auth.uid()
      )
    )
  );

-- Vendors can manage their own RFQ vendor items
CREATE POLICY "Vendor portal users can view their vendor items"
  ON public.rfq_vendor_items FOR SELECT
  TO authenticated
  USING (
    rfq_vendor_id IN (
      SELECT rv.id FROM public.rfq_vendors rv
      WHERE rv.vendor_id IN (
        SELECT c.id FROM public.contacts c WHERE c.portal_user_id = auth.uid()
      )
    )
  );

CREATE POLICY "Vendor portal users can insert their vendor items"
  ON public.rfq_vendor_items FOR INSERT
  TO authenticated
  WITH CHECK (
    rfq_vendor_id IN (
      SELECT rv.id FROM public.rfq_vendors rv
      WHERE rv.vendor_id IN (
        SELECT c.id FROM public.contacts c WHERE c.portal_user_id = auth.uid()
      )
    )
  );

CREATE POLICY "Vendor portal users can update their vendor items"
  ON public.rfq_vendor_items FOR UPDATE
  TO authenticated
  USING (
    rfq_vendor_id IN (
      SELECT rv.id FROM public.rfq_vendors rv
      WHERE rv.vendor_id IN (
        SELECT c.id FROM public.contacts c WHERE c.portal_user_id = auth.uid()
      )
    )
  );

-- Vendors can view their own vendor price list entries
CREATE POLICY "Vendor portal users can view their price lists"
  ON public.vendor_pricelists FOR SELECT
  TO authenticated
  USING (
    vendor_id IN (
      SELECT c.id FROM public.contacts c WHERE c.portal_user_id = auth.uid()
    )
  );

-- Vendors can view their own contact record
CREATE POLICY "Vendor portal users can view own contact"
  ON public.contacts FOR SELECT
  TO authenticated
  USING (portal_user_id = auth.uid());

-- Vendors can view RFQ headers they're invited to
CREATE POLICY "Vendor portal users can view their RFQ headers"
  ON public.rfqs FOR SELECT
  TO authenticated
  USING (
    id IN (
      SELECT rv.rfq_id FROM public.rfq_vendors rv
      WHERE rv.vendor_id IN (
        SELECT c.id FROM public.contacts c WHERE c.portal_user_id = auth.uid()
      )
    )
  );

-- Index for portal_user_id lookups
CREATE INDEX IF NOT EXISTS idx_contacts_portal_user_id ON public.contacts(portal_user_id) WHERE portal_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vendor_portal_invitations_token ON public.vendor_portal_invitations(token);
CREATE INDEX IF NOT EXISTS idx_vendor_portal_invitations_org ON public.vendor_portal_invitations(organization_id);

-- Helper function to check if user is a vendor portal user
CREATE OR REPLACE FUNCTION public.is_vendor_portal_user(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.contacts c WHERE c.portal_user_id = _user_id
  )
$$;

-- Helper function to get vendor's contact_id from their auth user_id
CREATE OR REPLACE FUNCTION public.get_vendor_contact_id(_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id FROM public.contacts c WHERE c.portal_user_id = _user_id LIMIT 1
$$;
