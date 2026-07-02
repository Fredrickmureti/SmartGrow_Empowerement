
-- App-included features mapping table
CREATE TABLE IF NOT EXISTS public.app_included_features (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  app_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(app_id, feature_key)
);

-- Enable RLS
ALTER TABLE public.app_included_features ENABLE ROW LEVEL SECURITY;

-- Platform admins can manage, all authenticated can read
CREATE POLICY "Anyone can read app_included_features"
  ON public.app_included_features
  FOR SELECT
  TO authenticated
  USING (true);

-- Seed the mapping data
INSERT INTO public.app_included_features (app_id, feature_key) VALUES
  -- Sales app features
  ('sales', 'estimates'),
  ('sales', 'credit_notes'),
  ('sales', 'recurring_invoices'),
  ('sales', 'proforma_invoices'),
  ('sales', 'delivery_notes'),
  ('sales', 'sales_orders'),
  ('sales', 'sales_returns'),
  ('sales', 'customer_statements'),
  -- Purchases app features
  ('purchases', 'bills'),
  ('purchases', 'purchase_returns'),
  ('purchases', 'purchase_orders'),
  -- Finance app features
  ('finance', 'journal_entries'),
  ('finance', 'fixed_assets'),
  ('finance', 'banking'),
  ('finance', 'budgets'),
  ('finance', 'reports_financial'),
  ('finance', 'reports_tax'),
  ('finance', 'reports_management'),
  -- HR app features
  ('hr', 'employees'),
  ('hr', 'leave'),
  ('hr', 'timesheets'),
  ('hr', 'payroll'),
  -- Inventory app features
  ('inventory', 'warehouses'),
  ('inventory', 'inventory_management'),
  -- POS app features
  ('pos', 'pos'),
  -- Documents app features
  ('documents', 'documents'),
  -- CRM app features
  ('crm', 'crm'),
  -- Projects app features
  ('projects', 'projects')
ON CONFLICT (app_id, feature_key) DO NOTHING;

-- Server-side user count enforcement function
CREATE OR REPLACE FUNCTION public.check_user_limit(p_org_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_users INT;
  v_current_users INT;
  v_override_limit INT;
  v_plan_id UUID;
BEGIN
  -- Get plan's max_users for this org
  SELECT psp.max_users, os.plan_id
  INTO v_max_users, v_plan_id
  FROM organization_subscriptions os
  JOIN platform_subscription_plans psp ON psp.id = os.plan_id
  WHERE os.organization_id = p_org_id
    AND os.status IN ('active', 'trialing')
  ORDER BY os.created_at DESC
  LIMIT 1;

  -- Check for per-org override on max_users
  SELECT (override_value)::int
  INTO v_override_limit
  FROM org_entitlement_overrides
  WHERE organization_id = p_org_id
    AND override_type = 'limit'
    AND feature_key = 'max_users'
    AND is_active = true
    AND (expires_at IS NULL OR expires_at > now())
  LIMIT 1;

  -- Use override if exists
  IF v_override_limit IS NOT NULL THEN
    v_max_users := v_override_limit;
  END IF;

  -- Count current active users (members of org)
  SELECT COUNT(*)
  INTO v_current_users
  FROM organization_members
  WHERE organization_id = p_org_id
    AND status = 'active';

  -- NULL max_users means unlimited
  IF v_max_users IS NULL THEN
    RETURN json_build_object(
      'allowed', true,
      'current_users', v_current_users,
      'max_users', null,
      'message', 'Unlimited users allowed'
    );
  END IF;

  IF v_current_users >= v_max_users THEN
    RETURN json_build_object(
      'allowed', false,
      'current_users', v_current_users,
      'max_users', v_max_users,
      'message', format('User limit reached (%s/%s). Upgrade your plan or contact support.', v_current_users, v_max_users)
    );
  END IF;

  RETURN json_build_object(
    'allowed', true,
    'current_users', v_current_users,
    'max_users', v_max_users,
    'message', format('Users: %s/%s', v_current_users, v_max_users)
  );
END;
$$;
