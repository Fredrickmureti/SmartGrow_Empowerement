-- Update Free plan
UPDATE platform_subscription_plans SET
  price_monthly = 0,
  price_yearly = 0,
  max_users = 1,
  max_organizations = 1,
  max_invoices_per_month = 50,
  description = 'Get started with essential accounting',
  features = '["1 user","50 invoices/month","Basic accounting","Contacts management","Sales & purchases","Email support"]'::jsonb,
  is_popular = false
WHERE name = 'Free';

-- Update Starter plan
UPDATE platform_subscription_plans SET
  price_monthly = 24,
  price_yearly = 240,
  max_users = 3,
  max_organizations = 1,
  max_invoices_per_month = NULL,
  description = 'Perfect for small businesses',
  features = '["3 users","Unlimited invoices","All core apps","Documents & Sign","Spreadsheets","Inventory management","Reports & analytics","Priority email support"]'::jsonb,
  is_popular = false
WHERE name = 'Starter';

-- Update Professional plan
UPDATE platform_subscription_plans SET
  price_monthly = 49,
  price_yearly = 490,
  max_users = 10,
  max_organizations = 3,
  max_invoices_per_month = NULL,
  description = 'For growing teams that need everything',
  features = '["10 users","Unlimited invoices","All apps included","POS & restaurant mode","HR & payroll","CRM & pipeline","Project management","Multi-currency","AI assistant","Business intelligence","Audit logs","Priority support"]'::jsonb,
  is_popular = true
WHERE name = 'Professional';

-- Update Enterprise plan
UPDATE platform_subscription_plans SET
  price_monthly = 99,
  price_yearly = 990,
  max_users = NULL,
  max_organizations = 10,
  max_invoices_per_month = NULL,
  description = 'Enterprise-grade with unlimited scale',
  features = '["Unlimited users","Unlimited invoices","All apps included","All premium features","Custom branding","API access","Dedicated support","Custom integrations","Advanced security"]'::jsonb,
  is_popular = false
WHERE name = 'Enterprise';

-- Seed premium feature access for all plans
-- First, ensure all premium features exist for all plans
INSERT INTO plan_feature_access (plan_id, feature_key, is_enabled)
SELECT p.id, f.key, false
FROM platform_subscription_plans p
CROSS JOIN (VALUES 
  ('multi_currency'), ('ai_assistant'), ('business_intelligence'),
  ('api_access'), ('custom_branding'), ('audit_logs'),
  ('team_management'), ('attendance')
) AS f(key)
WHERE NOT EXISTS (
  SELECT 1 FROM plan_feature_access pfa 
  WHERE pfa.plan_id = p.id AND pfa.feature_key = f.key
);

-- Enable premium features per plan tier
-- Free: team_management only
UPDATE plan_feature_access SET is_enabled = true
WHERE feature_key = 'team_management'
AND plan_id = (SELECT id FROM platform_subscription_plans WHERE name = 'Free');

-- Starter: team_management, attendance
UPDATE plan_feature_access SET is_enabled = true
WHERE feature_key IN ('team_management', 'attendance')
AND plan_id = (SELECT id FROM platform_subscription_plans WHERE name = 'Starter');

-- Professional: all except custom_branding and api_access
UPDATE plan_feature_access SET is_enabled = true
WHERE feature_key IN ('multi_currency', 'ai_assistant', 'business_intelligence', 'audit_logs', 'team_management', 'attendance')
AND plan_id = (SELECT id FROM platform_subscription_plans WHERE name = 'Professional');

-- Enterprise: everything
UPDATE plan_feature_access SET is_enabled = true
WHERE plan_id = (SELECT id FROM platform_subscription_plans WHERE name = 'Enterprise');