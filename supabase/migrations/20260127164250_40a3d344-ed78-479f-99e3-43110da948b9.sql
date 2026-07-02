-- Add business_id column to pos_shifts table
ALTER TABLE pos_shifts 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_pos_shifts_business_id ON pos_shifts(business_id);

-- Update RLS policy to include business_id access
DROP POLICY IF EXISTS "Users can manage shifts in their organization" ON pos_shifts;

CREATE POLICY "Users can manage shifts in their organization" 
ON pos_shifts 
FOR ALL 
USING (
  organization_id IN (
    SELECT organization_id FROM user_roles WHERE user_id = auth.uid()
  )
);