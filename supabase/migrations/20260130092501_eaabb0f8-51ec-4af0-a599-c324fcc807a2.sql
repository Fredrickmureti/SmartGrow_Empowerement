-- Add documents, sign, spreadsheets feature keys to Professional plan
INSERT INTO plan_feature_access (plan_id, feature_key, is_enabled)
SELECT '3e4fbab0-3652-43c7-85db-f2dbe0d66884', feature_key, true
FROM unnest(ARRAY['documents', 'sign', 'spreadsheets']) AS feature_key
ON CONFLICT DO NOTHING;

-- Add to Enterprise plan
INSERT INTO plan_feature_access (plan_id, feature_key, is_enabled)
SELECT '2e45711a-cdae-43ee-97a1-138c83010206', feature_key, true
FROM unnest(ARRAY['documents', 'sign', 'spreadsheets']) AS feature_key
ON CONFLICT DO NOTHING;

-- Add to Free plan (basic access)
INSERT INTO plan_feature_access (plan_id, feature_key, is_enabled)
SELECT '72cbf130-6de2-4f6d-9cbb-b736ff8452d8', feature_key, true
FROM unnest(ARRAY['documents', 'sign', 'spreadsheets']) AS feature_key
ON CONFLICT DO NOTHING;