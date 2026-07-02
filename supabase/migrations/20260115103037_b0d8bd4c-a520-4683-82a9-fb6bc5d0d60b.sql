-- Add DELETE policy for invitation revocation
CREATE POLICY "Admins and owners can delete invitations"
ON public.organization_invitations FOR DELETE
USING (
    public.has_role(auth.uid(), organization_id, 'owner') OR 
    public.has_role(auth.uid(), organization_id, 'admin')
);