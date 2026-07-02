
-- Add business_id column (nullable: NULL = all businesses)
ALTER TABLE ai_insights_cache ADD COLUMN business_id uuid REFERENCES businesses(id) ON DELETE CASCADE;

-- Drop old unique constraint
ALTER TABLE ai_insights_cache DROP CONSTRAINT IF EXISTS ai_insights_cache_organization_id_user_id_insight_type_key;

-- Create new unique index that handles NULLs
CREATE UNIQUE INDEX ai_insights_cache_org_user_type_biz_idx
  ON ai_insights_cache (organization_id, user_id, insight_type, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'));
