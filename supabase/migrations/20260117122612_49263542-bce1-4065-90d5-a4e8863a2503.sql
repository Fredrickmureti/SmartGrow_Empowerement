-- Fix RLS policy to allow cashiers to verify manager pins for overrides
-- Drop existing policy if it exists to avoid conflicts
DROP POLICY IF EXISTS "Organization members can view manager pins for override" ON public.pos_manager_pins;

-- Create policy that allows all organization members to SELECT manager pins
-- This is needed so cashiers can verify manager PINs during override workflows
CREATE POLICY "Organization members can view manager pins for override"
ON public.pos_manager_pins
FOR SELECT
USING (
  organization_id IN (
    SELECT organization_id FROM user_roles 
    WHERE user_id = auth.uid() AND is_active = true
  )
);