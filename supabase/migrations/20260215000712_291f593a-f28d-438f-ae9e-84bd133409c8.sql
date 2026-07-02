-- Allow employees to update their own record (self-service: personal fields)
CREATE POLICY "employees_self_update"
ON public.employees
FOR UPDATE
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());