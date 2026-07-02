-- Update Free plan: truthful features, per-user pricing
UPDATE platform_subscription_plans SET
  price_per_user_monthly = 0,
  price_per_user_yearly = 0,
  max_invoices_per_month = 50,
  description = 'Get started with basic accounting',
  features = '["1 user", "50 invoices/month", "Basic accounting", "Contacts management", "Sales & invoicing", "Email support"]'::jsonb
WHERE id = '72cbf130-6de2-4f6d-9cbb-b736ff8452d8';

-- Update Starter → rename to Growth with per-user pricing  
UPDATE platform_subscription_plans SET
  name = 'Growth',
  price_monthly = 12,
  price_yearly = 120,
  price_per_user_monthly = 4,
  price_per_user_yearly = 40,
  price_monthly_kes = 1550,
  price_yearly_kes = 15500,
  max_users = 10,
  max_organizations = 1,
  max_invoices_per_month = NULL,
  is_popular = false,
  description = 'For growing businesses',
  features = '["Up to 10 users", "Unlimited invoices", "Purchases & expenses", "Inventory management", "Financial reports", "Documents & Sign", "Spreadsheets", "Priority email support"]'::jsonb
WHERE id = '573f3b28-a287-4d1f-bf02-eb5455824e67';

-- Update Professional → rename to Business with per-user pricing
UPDATE platform_subscription_plans SET
  name = 'Business',
  price_monthly = 24,
  price_yearly = 240,
  price_per_user_monthly = 7,
  price_per_user_yearly = 70,
  price_monthly_kes = 3100,
  price_yearly_kes = 31000,
  max_users = 25,
  max_organizations = 3,
  max_invoices_per_month = NULL,
  is_popular = true,
  description = 'Complete business management suite',
  features = '["Up to 25 users", "Unlimited invoices", "All apps included", "Point of Sale", "HR & Payroll", "CRM & pipeline", "Project management", "Multi-currency", "AI assistant", "Priority support"]'::jsonb
WHERE id = '3e4fbab0-3652-43c7-85db-f2dbe0d66884';

-- Update Enterprise with per-user pricing
UPDATE platform_subscription_plans SET
  price_monthly = 49,
  price_yearly = 490,
  price_per_user_monthly = 0,
  price_per_user_yearly = 0,
  price_monthly_kes = 6350,
  price_yearly_kes = 63500,
  max_users = NULL,
  max_organizations = 10,
  max_invoices_per_month = NULL,
  description = 'For large teams with custom needs',
  features = '["Unlimited users", "Unlimited invoices", "All apps included", "All premium features", "Multi-currency", "AI assistant", "Audit logs", "Team management", "Dedicated support", "Custom integrations"]'::jsonb
WHERE id = '2e45711a-cdae-43ee-97a1-138c83010206';

-- Clean up false premium feature entries from plan_feature_access
DELETE FROM plan_feature_access WHERE feature_key IN ('api_access', 'custom_branding', 'business_intelligence', 'attendance');

-- Also clean up app-level entries that shouldn't be in plan_feature_access 
-- (they belong in plan_app_access, not feature access)
DELETE FROM plan_feature_access WHERE feature_key IN ('inventory', 'warehouses', 'documents', 'sign', 'spreadsheets', 'crm');