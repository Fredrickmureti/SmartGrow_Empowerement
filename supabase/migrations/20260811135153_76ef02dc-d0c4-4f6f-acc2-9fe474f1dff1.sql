ALTER TABLE public.expenses ALTER COLUMN status SET DEFAULT 'draft'::expense_status;

DROP POLICY IF EXISTS "expenses_insert" ON public.expenses;

CREATE POLICY "expenses_insert" ON public.expenses
  FOR INSERT TO authenticated
  WITH CHECK (
    public.check_org_subscription_active(organization_id)
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'create')
    AND status = 'draft'::expense_status
  );