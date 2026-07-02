-- Phase 1: Add missing columns to platform_subscription_plans
ALTER TABLE public.platform_subscription_plans 
ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS trial_period_days INTEGER DEFAULT 14;

-- Set the Free plan as default (using subquery for PostgreSQL compatibility)
UPDATE public.platform_subscription_plans 
SET is_default = true 
WHERE id = (
  SELECT id FROM public.platform_subscription_plans 
  WHERE LOWER(name) = 'free' OR price_monthly = 0 
  LIMIT 1
);

-- Phase 2: Fix the create_organization_with_owner RPC function
CREATE OR REPLACE FUNCTION public.create_organization_with_owner(org_name TEXT, org_slug TEXT)
RETURNS public.organizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_org public.organizations;
  default_plan_id UUID;
  trial_days INTEGER;
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

  -- Add current user as owner
  INSERT INTO public.organization_members (organization_id, user_id, role)
  VALUES (new_org.id, auth.uid(), 'owner');

  -- Add to user_roles for RLS compatibility
  INSERT INTO public.user_roles (organization_id, user_id, role, is_active)
  VALUES (new_org.id, auth.uid(), 'owner', true)
  ON CONFLICT (organization_id, user_id) DO NOTHING;

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
$$;