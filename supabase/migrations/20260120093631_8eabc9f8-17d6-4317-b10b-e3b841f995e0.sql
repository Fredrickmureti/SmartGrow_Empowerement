-- Seed ERP feature access for all active plans
-- CRM: Professional and Enterprise only
INSERT INTO plan_feature_access (plan_id, feature_key, is_enabled, limit_value)
SELECT id, 'crm', 
  CASE 
    WHEN name IN ('Professional', 'Enterprise') THEN true
    ELSE false 
  END,
  NULL
FROM platform_subscription_plans WHERE is_active = true
ON CONFLICT (plan_id, feature_key) DO NOTHING;

-- Projects: Starter, Professional, Enterprise
INSERT INTO plan_feature_access (plan_id, feature_key, is_enabled, limit_value)
SELECT id, 'projects',
  CASE 
    WHEN name = 'Free' THEN false
    ELSE true 
  END,
  NULL
FROM platform_subscription_plans WHERE is_active = true
ON CONFLICT (plan_id, feature_key) DO NOTHING;

-- Timesheets: Starter, Professional, Enterprise
INSERT INTO plan_feature_access (plan_id, feature_key, is_enabled, limit_value)
SELECT id, 'timesheets',
  CASE 
    WHEN name = 'Free' THEN false
    ELSE true 
  END,
  NULL
FROM platform_subscription_plans WHERE is_active = true
ON CONFLICT (plan_id, feature_key) DO NOTHING;

-- Leave: Starter, Professional, Enterprise
INSERT INTO plan_feature_access (plan_id, feature_key, is_enabled, limit_value)
SELECT id, 'leave',
  CASE 
    WHEN name = 'Free' THEN false
    ELSE true 
  END,
  NULL
FROM platform_subscription_plans WHERE is_active = true
ON CONFLICT (plan_id, feature_key) DO NOTHING;