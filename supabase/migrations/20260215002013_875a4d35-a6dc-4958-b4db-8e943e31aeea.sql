
-- ============================================================
-- Phase 1: Create user_business_access table (Odoo-aligned)
-- ============================================================

-- Table to control which businesses a user can access within an org
CREATE TABLE public.user_business_access (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  can_switch BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, business_id)
);

-- Index for fast lookups
CREATE INDEX idx_user_business_access_user_org ON public.user_business_access(user_id, organization_id);
CREATE INDEX idx_user_business_access_business ON public.user_business_access(business_id);

-- Enable RLS
ALTER TABLE public.user_business_access ENABLE ROW LEVEL SECURITY;

-- Users can read their own access rows
CREATE POLICY "users_read_own_business_access"
ON public.user_business_access
FOR SELECT
USING (user_id = auth.uid());

-- Admins (owner/admin/super_admin) can read all access rows in their org
CREATE POLICY "admins_read_all_business_access"
ON public.user_business_access
FOR SELECT
USING (
  organization_id IN (
    SELECT organization_id FROM public.user_roles 
    WHERE user_id = auth.uid() 
    AND role IN ('super_admin', 'owner', 'admin')
    AND is_active = true
  )
);

-- Admins can insert access rows for their org
CREATE POLICY "admins_insert_business_access"
ON public.user_business_access
FOR INSERT
WITH CHECK (
  organization_id IN (
    SELECT organization_id FROM public.user_roles 
    WHERE user_id = auth.uid() 
    AND role IN ('super_admin', 'owner', 'admin')
    AND is_active = true
  )
);

-- Admins can update access rows in their org
CREATE POLICY "admins_update_business_access"
ON public.user_business_access
FOR UPDATE
USING (
  organization_id IN (
    SELECT organization_id FROM public.user_roles 
    WHERE user_id = auth.uid() 
    AND role IN ('super_admin', 'owner', 'admin')
    AND is_active = true
  )
);

-- Admins can delete access rows in their org
CREATE POLICY "admins_delete_business_access"
ON public.user_business_access
FOR DELETE
USING (
  organization_id IN (
    SELECT organization_id FROM public.user_roles 
    WHERE user_id = auth.uid() 
    AND role IN ('super_admin', 'owner', 'admin')
    AND is_active = true
  )
);

-- ============================================================
-- Security definer function to check business access (avoids RLS recursion)
-- ============================================================
CREATE OR REPLACE FUNCTION public.user_has_business_access(_user_id UUID, _business_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_business_access
    WHERE user_id = _user_id AND business_id = _business_id
  );
$$;

-- Function to get all allowed business IDs for a user in an org
CREATE OR REPLACE FUNCTION public.get_user_allowed_businesses(_user_id UUID, _org_id UUID)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT business_id FROM public.user_business_access
  WHERE user_id = _user_id AND organization_id = _org_id;
$$;

-- ============================================================
-- Migration: Seed existing users with access to ALL businesses
-- (preserves current behavior, admins can restrict later)
-- ============================================================
INSERT INTO public.user_business_access (user_id, organization_id, business_id, is_primary, can_switch)
SELECT 
  ur.user_id,
  ur.organization_id,
  b.id AS business_id,
  -- Mark first business (alphabetically) as primary
  (ROW_NUMBER() OVER (PARTITION BY ur.user_id, ur.organization_id ORDER BY b.name) = 1) AS is_primary,
  -- Grant can_switch to admin roles by default, not to regular users
  (ur.role IN ('super_admin', 'owner', 'admin')) AS can_switch
FROM public.user_roles ur
JOIN public.businesses b ON b.organization_id = ur.organization_id AND b.is_active = true
WHERE ur.is_active = true
ON CONFLICT (user_id, business_id) DO NOTHING;

-- ============================================================
-- Trigger: auto-create access row when a new user_role is created
-- ============================================================
CREATE OR REPLACE FUNCTION public.auto_assign_business_access_on_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- When a user is added to an org, give them access to all active businesses
  -- (admin can restrict later)
  INSERT INTO public.user_business_access (user_id, organization_id, business_id, is_primary, can_switch)
  SELECT 
    NEW.user_id,
    NEW.organization_id,
    b.id,
    (ROW_NUMBER() OVER (ORDER BY b.name) = 1),
    (NEW.role IN ('super_admin', 'owner', 'admin'))
  FROM public.businesses b
  WHERE b.organization_id = NEW.organization_id AND b.is_active = true
  ON CONFLICT (user_id, business_id) DO NOTHING;
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_assign_business_access
AFTER INSERT ON public.user_roles
FOR EACH ROW
EXECUTE FUNCTION public.auto_assign_business_access_on_role();

-- ============================================================
-- Trigger: auto-grant access to ALL existing org members when a new business is created
-- ============================================================
CREATE OR REPLACE FUNCTION public.auto_assign_access_on_new_business()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_business_access (user_id, organization_id, business_id, is_primary, can_switch)
  SELECT 
    ur.user_id,
    NEW.organization_id,
    NEW.id,
    false, -- not primary (they already have a primary)
    (ur.role IN ('super_admin', 'owner', 'admin'))
  FROM public.user_roles ur
  WHERE ur.organization_id = NEW.organization_id AND ur.is_active = true
  ON CONFLICT (user_id, business_id) DO NOTHING;
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_assign_access_on_new_business
AFTER INSERT ON public.businesses
FOR EACH ROW
EXECUTE FUNCTION public.auto_assign_access_on_new_business();
