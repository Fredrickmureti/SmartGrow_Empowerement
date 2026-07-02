
-- Phase 2: Data Model Improvements for Contacts Module

-- 2a. Add default_currency to contacts
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS default_currency text;

-- 2b. Add default_payment_method_id to contacts
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS default_payment_method_id uuid REFERENCES public.organization_payment_methods(id);

-- 2c. Create contact_addresses table for multi-address support
CREATE TABLE IF NOT EXISTS public.contact_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  address_type text NOT NULL DEFAULT 'billing' CHECK (address_type IN ('billing', 'shipping', 'remittance', 'other')),
  label text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  country text,
  is_default boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.contact_addresses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage contact addresses in their org"
  ON public.contact_addresses
  FOR ALL
  TO authenticated
  USING (organization_id IN (SELECT id FROM public.organizations WHERE id = organization_id))
  WITH CHECK (organization_id IN (SELECT id FROM public.organizations WHERE id = organization_id));

-- 2d. Opening balance support
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS opening_balance numeric DEFAULT 0;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS opening_balance_date date;

-- 2e. Normalize customer_group with FK (add customer_group_id)
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS customer_group_id uuid REFERENCES public.customer_groups(id);

-- Phase 4c: Favorites/pinning
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS is_pinned boolean DEFAULT false;

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_contact_addresses_contact_id ON public.contact_addresses(contact_id);
CREATE INDEX IF NOT EXISTS idx_contacts_is_pinned ON public.contacts(is_pinned) WHERE is_pinned = true;
CREATE INDEX IF NOT EXISTS idx_contacts_customer_group_id ON public.contacts(customer_group_id);
