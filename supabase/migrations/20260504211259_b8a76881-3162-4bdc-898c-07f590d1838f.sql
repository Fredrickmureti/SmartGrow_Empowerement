-- Stage 5: branch-safe RLS for the Employees app.
-- The previous policy granted SELECT to anyone with hr/employees read; this
-- adds a defense-in-depth branch arm so branch-restricted users only see
-- employees & employee documents whose branch_id is in their assignments.
-- Self-service (own record) is preserved.

-- ============================================================
-- employees.SELECT
-- ============================================================
DROP POLICY IF EXISTS "employees_select_with_permission" ON public.employees;
CREATE POLICY "employees_select_with_permission" ON public.employees
  FOR SELECT TO authenticated
  USING (
    -- Self-service: own record always visible
    user_id = auth.uid()
    OR (
      public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'read')
      AND public.user_can_access_branch(auth.uid(), branch_id)
    )
  );

-- ============================================================
-- employee_documents.SELECT
-- (only patch if the table & policy actually exist; guard with DO block)
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'employee_documents' AND relnamespace = 'public'::regnamespace) THEN
    EXECUTE 'DROP POLICY IF EXISTS "employee_documents_select" ON public.employee_documents';
    -- Recreate with the branch arm.  Documents inherit the employee row's
    -- branch via a join so we don't depend on a denormalized branch_id column.
    EXECUTE $POL$
      CREATE POLICY "employee_documents_select" ON public.employee_documents
        FOR SELECT TO authenticated
        USING (
          EXISTS (
            SELECT 1 FROM public.employees e
            WHERE e.id = employee_documents.employee_id
              AND (
                e.user_id = auth.uid()
                OR (
                  public.user_has_module_permission(auth.uid(), e.organization_id, 'hr', 'read')
                  AND public.user_can_access_branch(auth.uid(), e.branch_id)
                )
              )
          )
        )
    $POL$;
  END IF;
END$$;