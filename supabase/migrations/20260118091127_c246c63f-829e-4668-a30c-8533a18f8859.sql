-- Phase 1: Fix Critical RLS Policy for Platform Admin Organization Updates
-- This allows platform admins to update any organization's subscription settings

-- Add UPDATE policy for platform admins on organizations table
CREATE POLICY "Platform admins can update any organization"
ON public.organizations FOR UPDATE
TO authenticated
USING (public.is_platform_admin(auth.uid()))
WITH CHECK (public.is_platform_admin(auth.uid()));

-- Phase 3: Create helper functions for limit enforcement

-- Function to check if user can create more organizations
CREATE OR REPLACE FUNCTION public.check_user_org_limit(_user_id uuid)
RETURNS TABLE(
  can_create boolean,
  current_count integer,
  max_allowed integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count INTEGER;
  v_max INTEGER;
  v_plan_id UUID;
BEGIN
  -- Count current organizations owned by user
  SELECT COUNT(*)::integer INTO v_count
  FROM user_roles ur
  WHERE ur.user_id = _user_id 
    AND ur.role = 'owner'
    AND ur.is_active = true;

  -- Get the max_organizations from the user's highest plan
  SELECT MAX(psp.max_organizations)::integer INTO v_max
  FROM user_roles ur
  JOIN organizations o ON o.id = ur.organization_id
  JOIN platform_subscription_plans psp ON psp.id = o.subscription_plan_id
  WHERE ur.user_id = _user_id AND ur.is_active = true;

  -- Default to 1 if no plan found
  v_max := COALESCE(v_max, 1);

  RETURN QUERY SELECT (v_count < v_max), v_count, v_max;
END;
$$;

-- Function to check if organization can create more businesses
CREATE OR REPLACE FUNCTION public.check_org_business_limit(_org_id uuid)
RETURNS TABLE(
  can_create boolean,
  current_count integer,
  max_allowed integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count INTEGER;
  v_max INTEGER;
BEGIN
  -- Count current businesses in organization
  SELECT COUNT(*)::integer INTO v_count
  FROM businesses
  WHERE organization_id = _org_id AND is_active = true;

  -- Get limit from plan_feature_access
  SELECT pfa.limit_value::integer INTO v_max
  FROM organizations o
  JOIN plan_feature_access pfa ON pfa.plan_id = o.subscription_plan_id
  WHERE o.id = _org_id AND pfa.feature_key = 'max_businesses';

  -- Default to 1 if no limit set (NULL means unlimited)
  IF v_max IS NULL THEN
    RETURN QUERY SELECT true, v_count, NULL::integer;
    RETURN;
  END IF;

  RETURN QUERY SELECT (v_count < v_max), v_count, v_max;
END;
$$;

-- Function to check if business can create more branches
CREATE OR REPLACE FUNCTION public.check_business_branch_limit(_business_id uuid)
RETURNS TABLE(
  can_create boolean,
  current_count integer,
  max_allowed integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count INTEGER;
  v_max INTEGER;
  v_org_id UUID;
BEGIN
  -- Get organization_id from business
  SELECT organization_id INTO v_org_id FROM businesses WHERE id = _business_id;

  -- Count current branches for this business
  SELECT COUNT(*)::integer INTO v_count
  FROM branches
  WHERE business_id = _business_id AND is_active = true;

  -- Get limit from plan_feature_access
  SELECT pfa.limit_value::integer INTO v_max
  FROM organizations o
  JOIN plan_feature_access pfa ON pfa.plan_id = o.subscription_plan_id
  WHERE o.id = v_org_id AND pfa.feature_key = 'max_branches';

  -- NULL means unlimited
  IF v_max IS NULL THEN
    RETURN QUERY SELECT true, v_count, NULL::integer;
    RETURN;
  END IF;

  RETURN QUERY SELECT (v_count < v_max), v_count, v_max;
END;
$$;

-- Phase 4: Add missing feature keys to plan_feature_access for existing plans
-- Insert max_businesses and max_branches features for all active plans

-- Free plan (typically sort_order = 0 or lowest price)
INSERT INTO public.plan_feature_access (plan_id, feature_key, is_enabled, limit_value)
SELECT id, 'max_businesses', true, 1
FROM platform_subscription_plans WHERE is_active = true
ON CONFLICT (plan_id, feature_key) DO NOTHING;

INSERT INTO public.plan_feature_access (plan_id, feature_key, is_enabled, limit_value)
SELECT id, 'max_branches', true, 1
FROM platform_subscription_plans WHERE is_active = true
ON CONFLICT (plan_id, feature_key) DO NOTHING;

-- Update limits based on plan tier (by name)
UPDATE plan_feature_access pfa
SET limit_value = CASE 
  WHEN psp.name ILIKE '%free%' THEN 1
  WHEN psp.name ILIKE '%starter%' OR psp.name ILIKE '%basic%' THEN 2
  WHEN psp.name ILIKE '%professional%' OR psp.name ILIKE '%pro%' THEN 5
  WHEN psp.name ILIKE '%enterprise%' OR psp.name ILIKE '%business%' THEN NULL -- unlimited
  ELSE 1
END
FROM platform_subscription_plans psp
WHERE pfa.plan_id = psp.id AND pfa.feature_key = 'max_businesses';

UPDATE plan_feature_access pfa
SET limit_value = CASE 
  WHEN psp.name ILIKE '%free%' THEN 1
  WHEN psp.name ILIKE '%starter%' OR psp.name ILIKE '%basic%' THEN 3
  WHEN psp.name ILIKE '%professional%' OR psp.name ILIKE '%pro%' THEN 10
  WHEN psp.name ILIKE '%enterprise%' OR psp.name ILIKE '%business%' THEN NULL -- unlimited
  ELSE 1
END
FROM platform_subscription_plans psp
WHERE pfa.plan_id = psp.id AND pfa.feature_key = 'max_branches';