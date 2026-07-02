-- Add 'hr' feature for Professional and Enterprise plans
INSERT INTO plan_feature_access (plan_id, feature_key, is_enabled, limit_value)
SELECT id, 'hr', true, null
FROM platform_subscription_plans 
WHERE name IN ('Professional', 'Enterprise')
ON CONFLICT (plan_id, feature_key) DO NOTHING;