-- Insert max_organizations into plan_feature_access for all active plans
INSERT INTO public.plan_feature_access (plan_id, feature_key, is_enabled, limit_value)
SELECT 
  id as plan_id,
  'max_organizations' as feature_key,
  true as is_enabled,
  CASE 
    WHEN name = 'Free' THEN 1
    WHEN name = 'Starter' THEN 1
    WHEN name = 'Professional' THEN 3
    WHEN name = 'Enterprise' THEN NULL  -- Unlimited
    ELSE 1
  END as limit_value
FROM public.platform_subscription_plans
WHERE is_active = true
ON CONFLICT (plan_id, feature_key) DO UPDATE SET
  limit_value = EXCLUDED.limit_value,
  updated_at = now();

-- Drop and recreate check_user_org_limit function to read from plan_feature_access
DROP FUNCTION IF EXISTS public.check_user_org_limit(uuid);

CREATE FUNCTION public.check_user_org_limit(_user_id uuid)
RETURNS TABLE(can_create boolean, current_count integer, max_allowed integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  -- Get the user's highest plan id
  SELECT psp.id INTO v_plan_id
  FROM user_roles ur
  JOIN organizations o ON o.id = ur.organization_id
  JOIN platform_subscription_plans psp ON psp.id = o.subscription_plan_id
  WHERE ur.user_id = _user_id AND ur.is_active = true
  ORDER BY psp.price_monthly DESC
  LIMIT 1;

  -- Try to get max_organizations from plan_feature_access first
  IF v_plan_id IS NOT NULL THEN
    SELECT pfa.limit_value::integer INTO v_max
    FROM plan_feature_access pfa
    WHERE pfa.plan_id = v_plan_id
      AND pfa.feature_key = 'max_organizations'
      AND pfa.is_enabled = true;
  END IF;

  -- If not found in plan_feature_access, fall back to platform_subscription_plans.max_organizations
  IF v_max IS NULL AND v_plan_id IS NOT NULL THEN
    SELECT psp.max_organizations::integer INTO v_max
    FROM platform_subscription_plans psp
    WHERE psp.id = v_plan_id;
  END IF;

  -- Default to 1 if no plan found
  v_max := COALESCE(v_max, 1);

  -- NULL in limit_value means unlimited, so treat it as can always create
  RETURN QUERY SELECT (v_max IS NULL OR v_count < v_max), v_count, v_max;
END;
$function$;