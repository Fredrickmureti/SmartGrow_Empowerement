-- Add RLS policy to allow authenticated users to read enabled bank providers
-- They should only see non-sensitive fields, so we'll create a view for that

-- First, add a SELECT policy for all authenticated users to read enabled providers
CREATE POLICY "Authenticated users can view enabled bank providers"
ON public.platform_bank_providers
FOR SELECT
TO authenticated
USING (is_enabled = true);

-- Note: The existing "Platform admins can manage bank providers" policy uses "ALL" 
-- which already covers SELECT for admins. The new policy allows regular users 
-- to see enabled providers only.