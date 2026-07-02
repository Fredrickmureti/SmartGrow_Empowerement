
-- ============================================================
-- Phase 3: Promote portal user to internal user (RPC)
-- Phase 4: Database safety constraint (role ↔ user_type)
-- ============================================================

-- 1. Constraint: portal role MUST have portal user_type, and vice versa
-- We use a trigger instead of CHECK because user_type is TEXT, not enum
CREATE OR REPLACE FUNCTION public.enforce_role_user_type_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- If role is 'portal', user_type MUST be 'portal'
  IF NEW.role = 'portal' AND (NEW.user_type IS NULL OR NEW.user_type != 'portal') THEN
    RAISE EXCEPTION 'role=portal requires user_type=portal';
  END IF;
  
  -- If user_type is 'portal', role MUST be 'portal'
  IF NEW.user_type = 'portal' AND NEW.role != 'portal' THEN
    RAISE EXCEPTION 'user_type=portal requires role=portal';
  END IF;
  
  -- If user_type is 'internal', role MUST NOT be 'portal'
  IF NEW.user_type = 'internal' AND NEW.role = 'portal' THEN
    RAISE EXCEPTION 'user_type=internal cannot have role=portal';
  END IF;
  
  RETURN NEW;
END;
$$;

-- Attach the trigger to user_roles
DROP TRIGGER IF EXISTS trg_enforce_role_user_type ON public.user_roles;
CREATE TRIGGER trg_enforce_role_user_type
  BEFORE INSERT OR UPDATE ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_role_user_type_consistency();

-- 2. RPC: Promote a portal user to an internal user
-- Only admins/owners can call this. Changes user_type and role atomically.
CREATE OR REPLACE FUNCTION public.promote_to_internal_user(
  p_user_id UUID,
  p_org_id UUID,
  p_new_role TEXT DEFAULT 'staff'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role TEXT;
  v_target_role TEXT;
  v_target_user_type TEXT;
BEGIN
  -- 1. Verify caller is admin/owner/super_admin in this org
  SELECT role INTO v_caller_role
  FROM public.user_roles
  WHERE user_id = auth.uid()
    AND organization_id = p_org_id
    AND is_active = true;
    
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('super_admin', 'owner', 'admin') THEN
    RAISE EXCEPTION 'Only admins can promote users';
  END IF;
  
  -- 2. Verify target user exists and is currently a portal user
  SELECT role, user_type INTO v_target_role, v_target_user_type
  FROM public.user_roles
  WHERE user_id = p_user_id
    AND organization_id = p_org_id
    AND is_active = true;
    
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user not found in this organization';
  END IF;
  
  IF v_target_user_type != 'portal' THEN
    RAISE EXCEPTION 'User is already an internal user';
  END IF;
  
  -- 3. Validate the new role is a valid internal role
  IF p_new_role NOT IN ('admin', 'accountant', 'staff', 'viewer', 'cashier') THEN
    RAISE EXCEPTION 'Invalid internal role: %', p_new_role;
  END IF;
  
  -- 4. Perform the promotion atomically
  UPDATE public.user_roles
  SET 
    role = p_new_role::app_role,
    user_type = 'internal',
    updated_at = now()
  WHERE user_id = p_user_id
    AND organization_id = p_org_id
    AND is_active = true;
    
  RETURN jsonb_build_object(
    'success', true,
    'user_id', p_user_id,
    'new_role', p_new_role,
    'new_user_type', 'internal'
  );
END;
$$;
