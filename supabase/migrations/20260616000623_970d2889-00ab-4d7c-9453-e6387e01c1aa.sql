
-- 1. Tighten read RLS on employee_garnishments (HR + self only, not whole org)
DROP POLICY IF EXISTS "employee_garnishments_org_read" ON public.employee_garnishments;
CREATE POLICY "employee_garnishments_hr_or_self_read"
ON public.employee_garnishments
FOR SELECT
TO authenticated
USING (
  (
    organization_id IN (SELECT uba.organization_id FROM public.user_business_access uba WHERE uba.user_id = auth.uid())
    AND (
      public.has_role(auth.uid(), 'admin')
      OR public.has_role(auth.uid(), 'owner')
      OR public.has_role(auth.uid(), 'accountant')
      OR public.has_role(auth.uid(), 'super_admin')
    )
  )
  OR employee_id IN (SELECT e.id FROM public.employees e WHERE e.user_id = auth.uid())
);

-- 2. Allow employees to read their own audit history
DROP POLICY IF EXISTS "garnishment_audit_self_read" ON public.garnishment_audit_log;
CREATE POLICY "garnishment_audit_self_read"
ON public.garnishment_audit_log
FOR SELECT
TO authenticated
USING (
  garnishment_id IN (
    SELECT g.id FROM public.employee_garnishments g
    JOIN public.employees e ON e.id = g.employee_id
    WHERE e.user_id = auth.uid()
  )
);

-- 3. Notify employee on lifecycle events
CREATE OR REPLACE FUNCTION public.garnishment_notify_employee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_org_id uuid;
  v_business_id uuid;
  v_emp_name text;
  v_kind text;
  v_status text;
  v_title text;
  v_msg text;
  v_after jsonb := COALESCE(NEW.after_state, NEW.before_state);
BEGIN
  IF NEW.action NOT IN ('created','status_changed','paid') THEN
    RETURN NEW;
  END IF;
  -- Resolve the employee → user
  SELECT e.user_id, e.organization_id, e.business_id, (e.first_name || ' ' || e.last_name)
    INTO v_user_id, v_org_id, v_business_id, v_emp_name
  FROM public.employee_garnishments g
  JOIN public.employees e ON e.id = g.employee_id
  WHERE g.id = NEW.garnishment_id;
  IF v_user_id IS NULL THEN RETURN NEW; END IF;

  v_kind := COALESCE(v_after->>'kind','order');
  v_status := COALESCE(v_after->>'status','active');

  IF NEW.action = 'created' THEN
    v_title := 'New garnishment order recorded';
    v_msg := 'A ' || v_kind || ' garnishment order has been added to your payroll. Reference: ' || COALESCE(v_after->>'case_reference','—');
  ELSIF NEW.action = 'status_changed' THEN
    v_title := 'Garnishment status updated';
    v_msg := 'Your ' || v_kind || ' garnishment is now ' || v_status || '.';
  ELSIF NEW.action = 'paid' THEN
    v_title := 'Garnishment payment posted';
    v_msg := 'A payment toward your ' || v_kind || ' garnishment was deducted in the latest payroll.';
  END IF;

  INSERT INTO public.notifications(organization_id, business_id, user_id, type, category, title, message, entity_type, entity_id, priority)
  VALUES (v_org_id, v_business_id, v_user_id, 'info', 'payroll', v_title, v_msg, 'employee_garnishment', NEW.garnishment_id,
          CASE WHEN NEW.action = 'created' THEN 2 ELSE 1 END);

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS garnishment_notify ON public.garnishment_audit_log;
CREATE TRIGGER garnishment_notify
AFTER INSERT ON public.garnishment_audit_log
FOR EACH ROW EXECUTE FUNCTION public.garnishment_notify_employee();
