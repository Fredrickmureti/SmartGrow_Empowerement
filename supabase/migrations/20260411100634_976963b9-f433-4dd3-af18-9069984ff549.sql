-- Fix the broken track_user_usage trigger function
-- It references column "period" but the table has "period_start" / "period_end"
CREATE OR REPLACE FUNCTION public.track_user_usage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_period_start DATE;
  v_period_end DATE;
  v_user_count INTEGER;
BEGIN
  v_period_start := date_trunc('month', CURRENT_DATE)::date;
  v_period_end := (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month' - INTERVAL '1 day')::date;
  
  SELECT COUNT(DISTINCT user_id) INTO v_user_count
  FROM user_roles
  WHERE organization_id = NEW.organization_id
  AND is_active = true;
  
  INSERT INTO subscription_usage (organization_id, period_start, period_end, users_count)
  VALUES (NEW.organization_id, v_period_start, v_period_end, v_user_count)
  ON CONFLICT (organization_id, period_start)
  DO UPDATE SET 
    users_count = v_user_count,
    updated_at = now();
    
  RETURN NEW;
END;
$function$;

-- Now provision workspace for masindecare@gmail.com
DO $$
DECLARE
  v_user_id UUID := '809e4edf-a653-47ba-b540-d98f365df5d6';
  v_org_id UUID;
  v_plan_id UUID;
  v_trial_days INTEGER;
  v_business_id UUID;
BEGIN
  -- Get default plan
  SELECT id, trial_period_days INTO v_plan_id, v_trial_days
  FROM public.platform_subscription_plans
  WHERE is_default = true AND is_active = true
  LIMIT 1;

  -- Safety: skip if user already has a role
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_user_id) THEN
    RAISE NOTICE 'User already has a role, skipping';
    RETURN;
  END IF;

  -- Create organization
  INSERT INTO public.organizations (
    name, slug, country, base_currency, business_type,
    subscription_plan_id, subscription_status, trial_ends_at
  )
  VALUES (
    'FINATIQ WORLD MOTORS', 'finatiq-world-motors', 'KE', 'KES', 'other',
    v_plan_id,
    CASE WHEN v_plan_id IS NOT NULL THEN 'trial' ELSE NULL END,
    CASE WHEN v_plan_id IS NOT NULL AND v_trial_days IS NOT NULL 
         THEN NOW() + (v_trial_days || ' days')::INTERVAL ELSE NULL END
  )
  RETURNING id INTO v_org_id;

  -- Owner role (this will now trigger the fixed track_user_usage)
  INSERT INTO public.user_roles (organization_id, user_id, role, is_active)
  VALUES (v_org_id, v_user_id, 'owner', true)
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  -- Default business
  INSERT INTO public.businesses (organization_id, name, country, is_active, base_currency)
  VALUES (v_org_id, 'FINATIQ WORLD MOTORS', 'KE', true, 'KES')
  RETURNING id INTO v_business_id;

  -- Default branch
  INSERT INTO public.branches (organization_id, business_id, name, is_headquarters, is_active)
  VALUES (v_org_id, v_business_id, 'Main Branch', true, true);

  -- Seed permission groups
  PERFORM public.seed_default_permission_groups(v_org_id);

  -- Install apps
  INSERT INTO public.organization_installed_apps (organization_id, app_id, installed_by)
  VALUES 
    (v_org_id, 'finance', v_user_id),
    (v_org_id, 'sales', v_user_id),
    (v_org_id, 'purchases', v_user_id),
    (v_org_id, 'platform', v_user_id),
    (v_org_id, 'inventory', v_user_id),
    (v_org_id, 'reports', v_user_id)
  ON CONFLICT DO NOTHING;

  -- Employee record
  INSERT INTO public.employees (
    organization_id, business_id, employee_number,
    first_name, last_name, email, user_id,
    position, hire_date, employment_type,
    basic_salary, housing_allowance, transport_allowance,
    is_active, user_access_status
  )
  VALUES (
    v_org_id, v_business_id, 'EMP-0001',
    'Masinde', '', 'masindecare@gmail.com', v_user_id,
    'Owner / Founder', CURRENT_DATE, 'full_time',
    0, 0, 0, true, 'active'
  );

  RAISE NOTICE 'Workspace created. Org ID: %', v_org_id;
END $$;