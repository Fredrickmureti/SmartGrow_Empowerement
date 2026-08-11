-- ---------------------------------------------------------------
-- Phase 6A — collapse overlapping expense policies to one per command
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can delete all expenses" ON public.expenses;
DROP POLICY IF EXISTS "Users can delete pending expenses" ON public.expenses;
DROP POLICY IF EXISTS "Platform admins can view all expenses" ON public.expenses;
DROP POLICY IF EXISTS "Subscription active check for insert on expenses" ON public.expenses;
DROP POLICY IF EXISTS "block_expense_insert_expired_sub" ON public.expenses;
DROP POLICY IF EXISTS "expenses_insert_perm" ON public.expenses;
DROP POLICY IF EXISTS "expenses_select_v2" ON public.expenses;
DROP POLICY IF EXISTS "expenses_update_v2" ON public.expenses;
DROP POLICY IF EXISTS "expenses_delete_v2" ON public.expenses;

-- Requester-scoped visibility helper: own record, or a direct/indirect report.
CREATE OR REPLACE FUNCTION public.expense_is_own_or_report(
  _user_id uuid,
  _created_by uuid,
  _employee_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    _created_by = _user_id
    OR (
      _employee_id IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM public.employees e
          WHERE e.id = _employee_id AND e.user_id = _user_id
        )
        OR public.is_manager_of(_user_id, _employee_id)
      )
    );
$$;

REVOKE ALL ON FUNCTION public.expense_is_own_or_report(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_is_own_or_report(uuid, uuid, uuid) TO authenticated, service_role;

CREATE POLICY "expenses_select" ON public.expenses
  FOR SELECT TO authenticated
  USING (
    public.is_platform_admin(auth.uid())
    OR (
      public.user_can_access_business(auth.uid(), business_id)
      AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'read')
      AND (
        public.is_finance_manager(auth.uid(), organization_id)
        OR public.expense_is_own_or_report(auth.uid(), created_by, employee_id)
      )
    )
  );

CREATE POLICY "expenses_insert" ON public.expenses
  FOR INSERT TO authenticated
  WITH CHECK (
    public.check_org_subscription_active(organization_id)
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'create')
  );

CREATE POLICY "expenses_update" ON public.expenses
  FOR UPDATE TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'write')
    AND status IN ('draft', 'pending', 'submitted', 'rejected')
    AND (
      public.is_finance_manager(auth.uid(), organization_id)
      OR public.expense_is_own_or_report(auth.uid(), created_by, employee_id)
    )
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'write')
    AND status IN ('draft', 'pending', 'submitted', 'rejected')
  );

CREATE POLICY "expenses_delete" ON public.expenses
  FOR DELETE TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'delete')
    AND status IN ('draft', 'pending', 'rejected')
  );

-- ---------------------------------------------------------------
-- Phase 6B — notify approvers and Finance, not the whole organisation
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_expense_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id uuid;
BEGIN
  FOR v_user_id IN
    SELECT ur.user_id
    FROM public.user_roles ur
    WHERE ur.organization_id = NEW.organization_id
      AND ur.is_active = true
      AND ur.role IN ('owner', 'admin', 'super_admin', 'accountant')
    UNION
    SELECT m.user_id
    FROM public.employees e
    JOIN public.employees m ON m.id = e.manager_id
    WHERE e.id = NEW.employee_id
      AND m.user_id IS NOT NULL
  LOOP
    CONTINUE WHEN v_user_id IS NULL OR v_user_id = NEW.created_by;

    PERFORM public.create_notification(
      NEW.organization_id,
      v_user_id,
      'info',
      'expense',
      'Expense Recorded',
      'Expense of ' || NEW.amount || ' recorded - ' || COALESCE(NEW.description, 'No description'),
      '/expenses',
      'expense',
      NEW.id,
      0,
      NEW.business_id
    );
  END LOOP;

  RETURN NEW;
END;
$function$;