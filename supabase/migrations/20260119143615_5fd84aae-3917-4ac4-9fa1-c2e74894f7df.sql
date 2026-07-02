-- Fix function search paths for security compliance
-- Drop and recreate functions with proper search_path settings

-- First drop the function with changed signature
DROP FUNCTION IF EXISTS public.get_user_allowed_branches(UUID, UUID);

-- Fix is_org_admin function
CREATE OR REPLACE FUNCTION public.is_org_admin(_user_id UUID, _organization_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.user_roles 
    WHERE user_id = _user_id 
    AND organization_id = _organization_id
    AND role IN ('super_admin', 'owner', 'admin')
    AND is_active = true
  );
END;
$$;

-- Fix can_access_branch function
CREATE OR REPLACE FUNCTION public.can_access_branch(_user_id UUID, _branch_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  -- Get the organization_id for this branch
  SELECT b.organization_id INTO v_org_id
  FROM public.branches b
  WHERE b.id = _branch_id;
  
  -- If branch doesn't exist, deny access
  IF v_org_id IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Check if user is org admin (full access)
  IF public.is_org_admin(_user_id, v_org_id) THEN
    RETURN TRUE;
  END IF;
  
  -- Check explicit branch assignment
  RETURN EXISTS (
    SELECT 1 FROM public.user_branch_assignments
    WHERE user_id = _user_id 
    AND branch_id = _branch_id
    AND can_view = true
  );
END;
$$;

-- Fix can_manage_branch function
CREATE OR REPLACE FUNCTION public.can_manage_branch(_user_id UUID, _branch_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  -- Get the organization_id for this branch
  SELECT b.organization_id INTO v_org_id
  FROM public.branches b
  WHERE b.id = _branch_id;
  
  -- If branch doesn't exist, deny access
  IF v_org_id IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Check if user is org admin (full management access)
  IF public.is_org_admin(_user_id, v_org_id) THEN
    RETURN TRUE;
  END IF;
  
  -- Check explicit branch management assignment
  RETURN EXISTS (
    SELECT 1 FROM public.user_branch_assignments
    WHERE user_id = _user_id 
    AND branch_id = _branch_id
    AND can_manage = true
  );
END;
$$;

-- Recreate get_user_allowed_branches with proper search_path
CREATE OR REPLACE FUNCTION public.get_user_allowed_branches(_user_id UUID, _business_id UUID)
RETURNS TABLE (
  id UUID,
  name TEXT,
  code TEXT,
  business_id UUID,
  organization_id UUID,
  is_headquarters BOOLEAN,
  is_active BOOLEAN,
  is_primary_assignment BOOLEAN,
  can_manage BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  -- Get organization_id for this business
  SELECT bus.organization_id INTO v_org_id
  FROM public.businesses bus
  WHERE bus.id = _business_id;
  
  -- If user is org admin, return all branches
  IF public.is_org_admin(_user_id, v_org_id) THEN
    RETURN QUERY
    SELECT 
      b.id,
      b.name,
      b.code,
      b.business_id,
      b.organization_id,
      b.is_headquarters,
      b.is_active,
      TRUE as is_primary_assignment,
      TRUE as can_manage
    FROM public.branches b
    WHERE b.business_id = _business_id
    AND b.is_active = true
    ORDER BY b.is_headquarters DESC, b.name;
  ELSE
    -- Return only assigned branches
    RETURN QUERY
    SELECT 
      b.id,
      b.name,
      b.code,
      b.business_id,
      b.organization_id,
      b.is_headquarters,
      b.is_active,
      uba.is_primary as is_primary_assignment,
      uba.can_manage
    FROM public.branches b
    INNER JOIN public.user_branch_assignments uba ON b.id = uba.branch_id
    WHERE b.business_id = _business_id
    AND uba.user_id = _user_id
    AND uba.can_view = true
    AND b.is_active = true
    ORDER BY uba.is_primary DESC, b.name;
  END IF;
END;
$$;

-- Fix get_user_primary_branch function
CREATE OR REPLACE FUNCTION public.get_user_primary_branch(_user_id UUID, _business_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branch_id UUID;
  v_org_id UUID;
BEGIN
  -- Get organization_id for this business
  SELECT bus.organization_id INTO v_org_id
  FROM public.businesses bus
  WHERE bus.id = _business_id;
  
  -- If user is org admin, return headquarters or first branch
  IF public.is_org_admin(_user_id, v_org_id) THEN
    SELECT b.id INTO v_branch_id
    FROM public.branches b
    WHERE b.business_id = _business_id
    AND b.is_active = true
    ORDER BY b.is_headquarters DESC, b.created_at
    LIMIT 1;
    
    RETURN v_branch_id;
  END IF;
  
  -- Get primary assigned branch
  SELECT uba.branch_id INTO v_branch_id
  FROM public.user_branch_assignments uba
  INNER JOIN public.branches b ON uba.branch_id = b.id
  WHERE uba.user_id = _user_id
  AND b.business_id = _business_id
  AND uba.is_primary = true
  AND b.is_active = true
  LIMIT 1;
  
  -- If no primary, get first assigned branch
  IF v_branch_id IS NULL THEN
    SELECT uba.branch_id INTO v_branch_id
    FROM public.user_branch_assignments uba
    INNER JOIN public.branches b ON uba.branch_id = b.id
    WHERE uba.user_id = _user_id
    AND b.business_id = _business_id
    AND uba.can_view = true
    AND b.is_active = true
    ORDER BY b.created_at
    LIMIT 1;
  END IF;
  
  RETURN v_branch_id;
END;
$$;

-- Fix update_updated_at_column function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Fix handle_new_user function
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$;

-- Fix generate_invoice_number function
CREATE OR REPLACE FUNCTION public.generate_invoice_number(p_organization_id UUID, p_business_id UUID DEFAULT NULL)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefix TEXT := 'INV';
  v_next_num INTEGER;
  v_invoice_number TEXT;
BEGIN
  -- Get business prefix if provided
  IF p_business_id IS NOT NULL THEN
    SELECT COALESCE(invoice_prefix, 'INV') INTO v_prefix
    FROM public.businesses
    WHERE id = p_business_id;
  END IF;
  
  -- Get next number
  SELECT COALESCE(MAX(
    CASE 
      WHEN invoice_number ~ '^[A-Z]+-[0-9]+$' 
      THEN CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INTEGER)
      ELSE 0
    END
  ), 0) + 1 INTO v_next_num
  FROM public.invoices
  WHERE organization_id = p_organization_id;
  
  v_invoice_number := v_prefix || '-' || LPAD(v_next_num::TEXT, 6, '0');
  
  RETURN v_invoice_number;
END;
$$;