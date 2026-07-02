-- Update the create_organization_with_owner function to auto-assign a default plan
CREATE OR REPLACE FUNCTION public.create_organization_with_owner(org_name text, org_slug text)
 RETURNS organizations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  new_org public.organizations;
  calling_user_id uuid;
  final_slug TEXT;
  slug_exists BOOLEAN;
  attempts INTEGER := 0;
  max_attempts INTEGER := 10;
  default_plan_id uuid;
BEGIN
  -- Get the current user's ID
  calling_user_id := auth.uid();
  
  IF calling_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- Generate unique slug (check all organizations, not just user-visible ones)
  final_slug := org_slug;
  
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM public.organizations WHERE slug = final_slug
    ) INTO slug_exists;
    
    EXIT WHEN NOT slug_exists;
    
    attempts := attempts + 1;
    IF attempts >= max_attempts THEN
      RAISE EXCEPTION 'Could not generate a unique organization URL. Please try a different name.';
    END IF;
    
    -- Append random suffix
    final_slug := org_slug || '-' || substr(md5(random()::text), 1, 4);
  END LOOP;
  
  -- Get the default free plan (lowest price, active)
  SELECT id INTO default_plan_id
  FROM public.platform_subscription_plans
  WHERE is_active = true
  ORDER BY price_monthly ASC, created_at ASC
  LIMIT 1;
  
  -- Insert organization with default plan and trial period
  INSERT INTO public.organizations (
    name, 
    slug, 
    subscription_plan_id, 
    subscription_status,
    trial_ends_at
  )
  VALUES (
    org_name, 
    final_slug, 
    default_plan_id,
    CASE WHEN default_plan_id IS NOT NULL THEN 'trialing' ELSE NULL END,
    CASE WHEN default_plan_id IS NOT NULL THEN now() + interval '14 days' ELSE NULL END
  )
  RETURNING * INTO new_org;
  
  -- Insert owner role for the current user
  INSERT INTO public.user_roles (user_id, organization_id, role)
  VALUES (calling_user_id, new_org.id, 'owner');
  
  -- Initialize subscription usage tracking for the new org
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
    date_trunc('month', now())::date,
    (date_trunc('month', now()) + interval '1 month' - interval '1 day')::date,
    0,
    1, -- Count the owner as the first user
    0,
    0,
    0
  );
  
  RETURN new_org;
END;
$function$;