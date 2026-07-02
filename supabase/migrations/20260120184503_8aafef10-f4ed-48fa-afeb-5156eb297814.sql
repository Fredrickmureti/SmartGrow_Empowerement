-- Update create_organization_with_owner to accept country, currency, and business type
-- This enables the signup flow to pre-configure the workspace with user's preferences

CREATE OR REPLACE FUNCTION public.create_organization_with_owner(
  org_name text, 
  org_slug text,
  org_country text DEFAULT NULL,
  org_currency text DEFAULT NULL,
  org_business_type text DEFAULT NULL
)
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
  resolved_currency TEXT;
  resolved_country TEXT;
BEGIN
  -- Resolve country and currency: use provided, or default to US/USD
  resolved_country := COALESCE(NULLIF(org_country, ''), 'US');
  resolved_currency := COALESCE(NULLIF(org_currency, ''), 'USD');

  -- Get the default plan with trial period
  SELECT id, trial_period_days INTO default_plan_id, trial_days
  FROM public.platform_subscription_plans
  WHERE is_default = true AND is_active = true
  LIMIT 1;

  -- Check if slug already exists
  IF EXISTS (SELECT 1 FROM public.organizations WHERE slug = org_slug) THEN
    RAISE EXCEPTION 'Organization with this slug already exists';
  END IF;

  -- Create the organization WITH country and currency from signup
  INSERT INTO public.organizations (
    name, 
    slug,
    country,
    base_currency,
    subscription_plan_id,
    subscription_status,
    trial_ends_at
  )
  VALUES (
    org_name, 
    org_slug,
    resolved_country,
    resolved_currency,
    default_plan_id,
    CASE WHEN default_plan_id IS NOT NULL THEN 'trial' ELSE NULL END,
    CASE WHEN default_plan_id IS NOT NULL AND trial_days IS NOT NULL 
         THEN NOW() + (trial_days || ' days')::INTERVAL 
         ELSE NULL END
  )
  RETURNING * INTO new_org;

  -- Add owner role
  INSERT INTO public.user_roles (organization_id, user_id, role, is_active)
  VALUES (new_org.id, auth.uid(), 'owner', true)
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  -- Create default business with SAME currency and country as org
  INSERT INTO public.businesses (
    organization_id,
    name,
    country,
    is_active,
    base_currency
  )
  VALUES (
    new_org.id,
    org_name,
    resolved_country,
    true,
    resolved_currency
  )
  RETURNING id INTO new_business_id;

  -- Create headquarters branch
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

  -- Initialize usage tracking
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
    0, 1, 0, 0, 0
  );

  RETURN new_org;
END;
$function$;