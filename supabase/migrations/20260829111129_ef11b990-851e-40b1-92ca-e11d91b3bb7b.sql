GRANT DELETE ON public.consolidation_group_change_log TO authenticated;

CREATE POLICY consolidation_group_change_log_admin_delete
  ON public.consolidation_group_change_log
  FOR DELETE
  TO authenticated
  USING (public.is_org_admin(auth.uid(), organization_id));