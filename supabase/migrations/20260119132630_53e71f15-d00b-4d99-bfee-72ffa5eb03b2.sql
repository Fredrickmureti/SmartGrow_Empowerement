-- Phase 2: Update create_organization_with_owner to auto-create default business and branch
-- Also add backfill logic and update the function

CREATE OR REPLACE FUNCTION public.create_organization_with_owner(org_name text, org_slug text)
 RETURNS organizations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  new_org public.organizations;
  default_plan_id UUID;
  trial_days INTEGER;
  new_business_id UUID;
  new_branch_id UUID;
BEGIN
  -- Get the default plan with trial period
  SELECT id, trial_period_days INTO default_plan_id, trial_days
  FROM public.platform_subscription_plans
  WHERE is_default = true AND is_active = true
  LIMIT 1;

  -- Create the organization with default plan and trial period
  INSERT INTO public.organizations (
    name, 
    slug, 
    subscription_plan_id,
    subscription_status,
    trial_ends_at
  )
  VALUES (
    org_name, 
    org_slug, 
    default_plan_id,
    CASE WHEN default_plan_id IS NOT NULL THEN 'trial' ELSE NULL END,
    CASE WHEN default_plan_id IS NOT NULL AND trial_days IS NOT NULL 
         THEN NOW() + (trial_days || ' days')::INTERVAL 
         ELSE NULL END
  )
  RETURNING * INTO new_org;

  -- Add to user_roles for membership and RLS compatibility
  INSERT INTO public.user_roles (organization_id, user_id, role, is_active)
  VALUES (new_org.id, auth.uid(), 'owner', true)
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  -- AUTO-CREATE DEFAULT BUSINESS
  INSERT INTO public.businesses (
    organization_id,
    name,
    is_active,
    base_currency
  )
  VALUES (
    new_org.id,
    org_name,  -- Use org name as default business name
    true,
    'KES'  -- Default currency, can be changed later
  )
  RETURNING id INTO new_business_id;

  -- AUTO-CREATE HEADQUARTERS BRANCH
  INSERT INTO public.branches (
    organization_id,
    business_id,
    name,
    is_headquarters,
    is_active
  )
  VALUES (
    new_org.id,
    new_business_id,
    'Main Branch',
    true,
    true
  )
  RETURNING id INTO new_branch_id;

  -- Initialize usage tracking in subscription_usage table
  INSERT INTO public.subscription_usage (
    organization_id,
    period_start,
    period_end,
    invoices_count,
    users_count,
    pos_transactions_count,
    storage_used_mb,
    api_calls_count
  )
  VALUES (
    new_org.id,
    date_trunc('month', NOW())::date,
    (date_trunc('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day')::date,
    0,
    1,
    0,
    0,
    0
  );

  RETURN new_org;
END;
$function$;

-- Create a helper function to get default business for an organization
CREATE OR REPLACE FUNCTION public.get_default_business_id(_org_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id 
  FROM public.businesses 
  WHERE organization_id = _org_id 
    AND is_active = true 
  ORDER BY created_at ASC 
  LIMIT 1;
$function$;

-- Create a helper function to get default branch for a business
CREATE OR REPLACE FUNCTION public.get_default_branch_id(_business_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id 
  FROM public.branches 
  WHERE business_id = _business_id 
    AND is_active = true 
  ORDER BY is_headquarters DESC, created_at ASC 
  LIMIT 1;
$function$;

-- Create function to ensure an organization has at least one business
CREATE OR REPLACE FUNCTION public.ensure_org_has_business(_org_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  existing_business_id UUID;
  new_business_id UUID;
  org_name TEXT;
BEGIN
  -- Check if business already exists
  SELECT id INTO existing_business_id
  FROM public.businesses
  WHERE organization_id = _org_id AND is_active = true
  LIMIT 1;
  
  IF existing_business_id IS NOT NULL THEN
    RETURN existing_business_id;
  END IF;
  
  -- Get org name for default business
  SELECT name INTO org_name FROM public.organizations WHERE id = _org_id;
  
  -- Create default business
  INSERT INTO public.businesses (
    organization_id,
    name,
    is_active,
    base_currency
  )
  VALUES (
    _org_id,
    COALESCE(org_name, 'Default Business'),
    true,
    'KES'
  )
  RETURNING id INTO new_business_id;
  
  -- Create default branch
  INSERT INTO public.branches (
    organization_id,
    business_id,
    name,
    is_headquarters,
    is_active
  )
  VALUES (
    _org_id,
    new_business_id,
    'Main Branch',
    true,
    true
  );
  
  RETURN new_business_id;
END;
$function$;