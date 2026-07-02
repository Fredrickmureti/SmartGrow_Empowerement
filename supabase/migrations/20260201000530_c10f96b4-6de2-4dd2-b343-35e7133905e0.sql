-- Drop existing policies
DROP POLICY IF EXISTS "Platform admins can manage plan_app_access" ON plan_app_access;
DROP POLICY IF EXISTS "Authenticated users can read plan_app_access" ON plan_app_access;

-- Create proper policies with WITH CHECK for INSERT/UPDATE operations
CREATE POLICY "Anyone can read plan_app_access"
ON plan_app_access FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Platform admins can insert plan_app_access"
ON plan_app_access FOR INSERT
TO authenticated
WITH CHECK (public.is_platform_admin(auth.uid()));

CREATE POLICY "Platform admins can update plan_app_access"
ON plan_app_access FOR UPDATE
TO authenticated
USING (public.is_platform_admin(auth.uid()))
WITH CHECK (public.is_platform_admin(auth.uid()));

CREATE POLICY "Platform admins can delete plan_app_access"
ON plan_app_access FOR DELETE
TO authenticated
USING (public.is_platform_admin(auth.uid()));