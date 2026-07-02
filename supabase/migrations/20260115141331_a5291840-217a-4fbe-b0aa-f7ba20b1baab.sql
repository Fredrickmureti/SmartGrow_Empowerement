-- Allow platform admins to delete any organization
CREATE POLICY "Platform admins can delete organizations"
ON public.organizations
FOR DELETE
TO authenticated
USING (is_platform_admin(auth.uid()));