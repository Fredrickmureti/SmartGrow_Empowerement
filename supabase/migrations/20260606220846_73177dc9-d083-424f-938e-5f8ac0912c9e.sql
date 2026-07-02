
DROP POLICY IF EXISTS employee_garnishments_hr_write ON public.employee_garnishments;
CREATE POLICY employee_garnishments_hr_write
  ON public.employee_garnishments FOR ALL
  TO authenticated
  USING (
    organization_id IN (
      SELECT uba.organization_id FROM public.user_business_access uba
       WHERE uba.user_id = auth.uid()
    )
    AND (
      public.has_role(auth.uid(), 'admin')
      OR public.has_role(auth.uid(), 'owner')
      OR public.has_role(auth.uid(), 'accountant')
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT uba.organization_id FROM public.user_business_access uba
       WHERE uba.user_id = auth.uid()
    )
    AND (
      public.has_role(auth.uid(), 'admin')
      OR public.has_role(auth.uid(), 'owner')
      OR public.has_role(auth.uid(), 'accountant')
    )
  );
