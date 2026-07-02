-- ============================================
-- USER BRANCH ASSIGNMENTS TABLE
-- ============================================

-- Create table for user-to-branch assignments
CREATE TABLE public.user_branch_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  is_primary BOOLEAN DEFAULT FALSE,
  can_view BOOLEAN DEFAULT TRUE,
  can_manage BOOLEAN DEFAULT FALSE,
  assigned_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, branch_id)
);

-- Create index for performance
CREATE INDEX idx_user_branch_assignments_user_id ON public.user_branch_assignments(user_id);
CREATE INDEX idx_user_branch_assignments_branch_id ON public.user_branch_assignments(branch_id);
CREATE INDEX idx_user_branch_assignments_business_id ON public.user_branch_assignments(business_id);

-- Enable RLS
ALTER TABLE public.user_branch_assignments ENABLE ROW LEVEL SECURITY;

-- Trigger for updated_at
CREATE TRIGGER update_user_branch_assignments_updated_at
  BEFORE UPDATE ON public.user_branch_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================
-- HELPER FUNCTIONS (SECURITY DEFINER)
-- ============================================

-- Check if user is admin/owner/super_admin
CREATE OR REPLACE FUNCTION public.is_org_admin(_user_id UUID, _organization_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 
    FROM user_roles 
    WHERE user_id = _user_id 
      AND organization_id = _organization_id
      AND role IN ('super_admin', 'owner', 'admin')
      AND is_active = true
  );
END;
$$;

-- Check if user can access a specific branch
CREATE OR REPLACE FUNCTION public.can_access_branch(_user_id UUID, _branch_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  -- Get the organization for this branch
  SELECT organization_id INTO v_org_id
  FROM branches
  WHERE id = _branch_id;
  
  IF v_org_id IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Super admins/owners/admins can access all branches in their org
  IF is_org_admin(_user_id, v_org_id) THEN
    RETURN TRUE;
  END IF;
  
  -- Check explicit branch assignment
  RETURN EXISTS (
    SELECT 1 
    FROM user_branch_assignments
    WHERE user_id = _user_id 
      AND branch_id = _branch_id
      AND can_view = true
  );
END;
$$;

-- Check if user can manage a specific branch
CREATE OR REPLACE FUNCTION public.can_manage_branch(_user_id UUID, _branch_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  -- Get the organization for this branch
  SELECT organization_id INTO v_org_id
  FROM branches
  WHERE id = _branch_id;
  
  IF v_org_id IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Super admins/owners/admins can manage all branches in their org
  IF is_org_admin(_user_id, v_org_id) THEN
    RETURN TRUE;
  END IF;
  
  -- Check explicit branch management permission
  RETURN EXISTS (
    SELECT 1 
    FROM user_branch_assignments
    WHERE user_id = _user_id 
      AND branch_id = _branch_id
      AND can_manage = true
  );
END;
$$;

-- Get all branches a user can access for a specific business
CREATE OR REPLACE FUNCTION public.get_user_allowed_branches(_user_id UUID, _business_id UUID)
RETURNS TABLE (
  id UUID,
  business_id UUID,
  organization_id UUID,
  name TEXT,
  code TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT,
  is_headquarters BOOLEAN,
  is_active BOOLEAN,
  is_primary_assignment BOOLEAN,
  can_manage BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  -- Get the organization for this business
  SELECT b.organization_id INTO v_org_id
  FROM businesses b
  WHERE b.id = _business_id;
  
  IF v_org_id IS NULL THEN
    RETURN;
  END IF;
  
  -- If admin/owner, return all branches with full access
  IF is_org_admin(_user_id, v_org_id) THEN
    RETURN QUERY
    SELECT 
      br.id,
      br.business_id,
      br.organization_id,
      br.name,
      br.code,
      br.email,
      br.phone,
      br.address,
      br.city,
      br.state,
      br.postal_code,
      br.country,
      br.is_headquarters,
      br.is_active,
      COALESCE(uba.is_primary, br.is_headquarters) as is_primary_assignment,
      TRUE as can_manage,
      br.created_at,
      br.updated_at
    FROM branches br
    LEFT JOIN user_branch_assignments uba 
      ON uba.branch_id = br.id AND uba.user_id = _user_id
    WHERE br.business_id = _business_id
      AND br.is_active = true
    ORDER BY br.is_headquarters DESC, br.name;
  ELSE
    -- Return only assigned branches
    RETURN QUERY
    SELECT 
      br.id,
      br.business_id,
      br.organization_id,
      br.name,
      br.code,
      br.email,
      br.phone,
      br.address,
      br.city,
      br.state,
      br.postal_code,
      br.country,
      br.is_headquarters,
      br.is_active,
      uba.is_primary as is_primary_assignment,
      uba.can_manage,
      br.created_at,
      br.updated_at
    FROM branches br
    INNER JOIN user_branch_assignments uba 
      ON uba.branch_id = br.id AND uba.user_id = _user_id
    WHERE br.business_id = _business_id
      AND br.is_active = true
      AND uba.can_view = true
    ORDER BY uba.is_primary DESC, br.is_headquarters DESC, br.name;
  END IF;
END;
$$;

-- Get user's primary branch for a business
CREATE OR REPLACE FUNCTION public.get_user_primary_branch(_user_id UUID, _business_id UUID)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branch_id UUID;
  v_org_id UUID;
BEGIN
  -- Get the organization for this business
  SELECT b.organization_id INTO v_org_id
  FROM businesses b
  WHERE b.id = _business_id;
  
  IF v_org_id IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- Try to get explicitly set primary branch
  SELECT uba.branch_id INTO v_branch_id
  FROM user_branch_assignments uba
  WHERE uba.user_id = _user_id
    AND uba.business_id = _business_id
    AND uba.is_primary = true
  LIMIT 1;
  
  IF v_branch_id IS NOT NULL THEN
    RETURN v_branch_id;
  END IF;
  
  -- If admin/owner, use headquarters
  IF is_org_admin(_user_id, v_org_id) THEN
    SELECT br.id INTO v_branch_id
    FROM branches br
    WHERE br.business_id = _business_id
      AND br.is_active = true
    ORDER BY br.is_headquarters DESC, br.created_at
    LIMIT 1;
    RETURN v_branch_id;
  END IF;
  
  -- Otherwise, use first assigned branch
  SELECT uba.branch_id INTO v_branch_id
  FROM user_branch_assignments uba
  INNER JOIN branches br ON br.id = uba.branch_id
  WHERE uba.user_id = _user_id
    AND uba.business_id = _business_id
    AND br.is_active = true
  ORDER BY uba.is_primary DESC, br.is_headquarters DESC, br.name
  LIMIT 1;
  
  RETURN v_branch_id;
END;
$$;

-- ============================================
-- RLS POLICIES
-- ============================================

-- Users can view their own branch assignments
CREATE POLICY "Users can view own branch assignments"
ON public.user_branch_assignments FOR SELECT
USING (user_id = auth.uid());

-- Admins can view all assignments in their org
CREATE POLICY "Admins can view all branch assignments"
ON public.user_branch_assignments FOR SELECT
USING (
  is_org_admin(auth.uid(), organization_id)
);

-- Admins can insert branch assignments
CREATE POLICY "Admins can create branch assignments"
ON public.user_branch_assignments FOR INSERT
WITH CHECK (
  is_org_admin(auth.uid(), organization_id)
);

-- Admins can update branch assignments
CREATE POLICY "Admins can update branch assignments"
ON public.user_branch_assignments FOR UPDATE
USING (
  is_org_admin(auth.uid(), organization_id)
);

-- Admins can delete branch assignments
CREATE POLICY "Admins can delete branch assignments"
ON public.user_branch_assignments FOR DELETE
USING (
  is_org_admin(auth.uid(), organization_id)
);

-- ============================================
-- UPDATE BRANCH-SCOPED TABLE POLICIES
-- ============================================

-- Update POS transactions policy to use branch access check
DROP POLICY IF EXISTS "Users can view POS transactions from their organization" ON public.pos_transactions;
CREATE POLICY "Users can view POS transactions from their branch"
ON public.pos_transactions FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM user_roles 
    WHERE user_id = auth.uid() 
    AND organization_id = pos_transactions.organization_id 
    AND is_active = true
  )
  AND (
    branch_id IS NULL 
    OR can_access_branch(auth.uid(), branch_id)
  )
);

-- Update POS shifts policy
DROP POLICY IF EXISTS "Users can view POS shifts from their organization" ON public.pos_shifts;
CREATE POLICY "Users can view POS shifts from their branch"
ON public.pos_shifts FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM user_roles 
    WHERE user_id = auth.uid() 
    AND organization_id = pos_shifts.organization_id 
    AND is_active = true
  )
  AND (
    branch_id IS NULL 
    OR can_access_branch(auth.uid(), branch_id)
  )
);

-- Update POS registers policy
DROP POLICY IF EXISTS "Users can view POS registers from their organization" ON public.pos_registers;
CREATE POLICY "Users can view POS registers from their branch"
ON public.pos_registers FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM user_roles 
    WHERE user_id = auth.uid() 
    AND organization_id = pos_registers.organization_id 
    AND is_active = true
  )
  AND (
    branch_id IS NULL 
    OR can_access_branch(auth.uid(), branch_id)
  )
);