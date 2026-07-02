-- Fix pos_manager_overrides INSERT policy
-- The current policy incorrectly requires manager_id = auth.uid(), but the CASHIER is logged in
-- when requesting an override. The manager is verified via PIN, not their session.

-- Drop the restrictive policy
DROP POLICY IF EXISTS "Managers can create overrides" ON public.pos_manager_overrides;

-- Create a new policy that allows any org member to insert override records
-- Security is enforced by PIN verification in the application layer
CREATE POLICY "Organization members can record overrides"
ON public.pos_manager_overrides
FOR INSERT
WITH CHECK (
  organization_id IN (
    SELECT organization_id FROM user_roles 
    WHERE user_id = auth.uid() AND is_active = true
  )
);

-- Also ensure profiles can be read by org members for showing manager name
-- The existing policy uses users_share_organization which should work,
-- but let's verify the function exists and add a simpler fallback policy
CREATE POLICY "Org members can view profiles for display"
ON public.profiles
FOR SELECT
USING (
  user_id IN (
    SELECT ur2.user_id 
    FROM user_roles ur1
    JOIN user_roles ur2 ON ur1.organization_id = ur2.organization_id
    WHERE ur1.user_id = auth.uid() AND ur1.is_active = true AND ur2.is_active = true
  )
);