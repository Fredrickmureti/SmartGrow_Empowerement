-- Phase 1: Remove page-level feature keys from plan_feature_access
-- Keep only real cross-cutting premium features: multi_currency, ai_assistant, audit_logs, team_management
DELETE FROM plan_feature_access 
WHERE feature_key NOT IN ('multi_currency', 'ai_assistant', 'audit_logs', 'team_management');

-- Phase 2: Remove unused stripe_price_id columns from platform_subscription_plans
-- These are never populated and the system uses dynamic pricing via edge functions
ALTER TABLE platform_subscription_plans DROP COLUMN IF EXISTS stripe_price_id_monthly;
ALTER TABLE platform_subscription_plans DROP COLUMN IF EXISTS stripe_price_id_yearly;