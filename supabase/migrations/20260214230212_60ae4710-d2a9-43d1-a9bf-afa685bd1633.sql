-- Fix: Allow employees to always SELECT their own record (self-service)
-- This mirrors Odoo where every employee can see their own profile regardless of HR access rights

DROP POLICY IF EXISTS "employees_select_with_permission" ON public.employees;

CREATE POLICY "employees_select_with_permission" ON public.employees
  FOR SELECT TO authenticated
  USING (
    -- Self-service: every user can always read their OWN employee record
    user_id = auth.uid()
    OR
    -- HR permission: users with hr read access can see all employees in their org
    public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'read')
  );