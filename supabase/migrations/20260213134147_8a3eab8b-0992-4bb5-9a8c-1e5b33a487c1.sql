
-- Step 1: Add user_type column to organization_invitations
ALTER TABLE public.organization_invitations 
ADD COLUMN IF NOT EXISTS user_type TEXT NOT NULL DEFAULT 'internal';

-- Step 2: Create seed_default_permission_groups function
CREATE OR REPLACE FUNCTION public.seed_default_permission_groups(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  portal_group_id UUID;
  internal_group_id UUID;
BEGIN
  -- Only seed if org has no system groups yet
  IF EXISTS (
    SELECT 1 FROM public.permission_groups 
    WHERE organization_id = p_org_id AND is_system = true
  ) THEN
    RETURN;
  END IF;

  -- Create Portal User group
  INSERT INTO public.permission_groups (organization_id, name, description, is_system)
  VALUES (p_org_id, 'Portal User', 'Self-service access: view payslips, request leave, submit timesheets', true)
  RETURNING id INTO portal_group_id;

  -- Portal rules: read-only on leave, timesheets, projects (logTime)
  INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
    (portal_group_id, 'leave', true, false, false, false),
    (portal_group_id, 'timesheets', true, false, false, false),
    (portal_group_id, 'projects', true, false, false, false);

  -- Create Internal User group
  INSERT INTO public.permission_groups (organization_id, name, description, is_system)
  VALUES (p_org_id, 'Internal User', 'Full backend access to all modules based on assigned role', true)
  RETURNING id INTO internal_group_id;

  -- Internal rules: full RCWD on all modules
  INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
    (internal_group_id, 'contacts', true, true, true, true),
    (internal_group_id, 'products', true, true, true, true),
    (internal_group_id, 'sales', true, true, true, true),
    (internal_group_id, 'purchases', true, true, true, true),
    (internal_group_id, 'financials', true, true, true, true),
    (internal_group_id, 'hr', true, true, true, true),
    (internal_group_id, 'leave', true, true, true, true),
    (internal_group_id, 'timesheets', true, true, true, true),
    (internal_group_id, 'projects', true, true, true, true),
    (internal_group_id, 'payroll', true, true, true, true),
    (internal_group_id, 'pos', true, true, true, true),
    (internal_group_id, 'settings', true, true, true, true),
    (internal_group_id, 'team', true, true, true, true);
END;
$$;

-- Step 3: Update create_organization_with_owner to call seed_default_permission_groups
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
  resolved_country := COALESCE(NULLIF(org_country, ''), 'US');
  resolved_currency := COALESCE(NULLIF(org_currency, ''), 'USD');

  SELECT id, trial_period_days INTO default_plan_id, trial_days
  FROM public.platform_subscription_plans
  WHERE is_default = true AND is_active = true
  LIMIT 1;

  IF EXISTS (SELECT 1 FROM public.organizations WHERE slug = org_slug) THEN
    RAISE EXCEPTION 'Organization with this slug already exists';
  END IF;

  INSERT INTO public.organizations (
    name, slug, country, base_currency,
    subscription_plan_id, subscription_status, trial_ends_at
  )
  VALUES (
    org_name, org_slug, resolved_country, resolved_currency,
    default_plan_id,
    CASE WHEN default_plan_id IS NOT NULL THEN 'trial' ELSE NULL END,
    CASE WHEN default_plan_id IS NOT NULL AND trial_days IS NOT NULL 
         THEN NOW() + (trial_days || ' days')::INTERVAL 
         ELSE NULL END
  )
  RETURNING * INTO new_org;

  INSERT INTO public.user_roles (organization_id, user_id, role, is_active)
  VALUES (new_org.id, auth.uid(), 'owner', true)
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  INSERT INTO public.businesses (organization_id, name, country, is_active, base_currency)
  VALUES (new_org.id, org_name, resolved_country, true, resolved_currency)
  RETURNING id INTO new_business_id;

  INSERT INTO public.branches (organization_id, business_id, name, is_headquarters, is_active)
  VALUES (new_org.id, new_business_id, 'Main Branch', true, true)
  RETURNING id INTO new_branch_id;

  INSERT INTO public.subscription_usage (
    organization_id, period_start, period_end,
    invoices_count, users_count, pos_transactions_count, storage_used_mb, api_calls_count
  )
  VALUES (
    new_org.id,
    date_trunc('month', NOW())::date,
    (date_trunc('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day')::date,
    0, 1, 0, 0, 0
  );

  -- Seed default permission groups (Portal User + Internal User)
  PERFORM public.seed_default_permission_groups(new_org.id);

  RETURN new_org;
END;
$function$;

-- Step 4: Seed default groups for ALL existing organizations that don't have them
DO $$
DECLARE
  org_record RECORD;
BEGIN
  FOR org_record IN 
    SELECT id FROM public.organizations 
    WHERE id NOT IN (
      SELECT DISTINCT organization_id FROM public.permission_groups WHERE is_system = true
    )
  LOOP
    PERFORM public.seed_default_permission_groups(org_record.id);
  END LOOP;
END;
$$;
