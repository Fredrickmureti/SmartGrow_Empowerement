
CREATE OR REPLACE FUNCTION public.auto_create_employment_on_employee_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.employments WHERE employee_id = NEW.id) THEN
    INSERT INTO public.employments (
      organization_id, business_id, branch_id, employee_id,
      start_date, end_date, employment_type, status,
      termination_type, is_primary
    )
    VALUES (
      NEW.organization_id,
      NEW.business_id,
      NEW.branch_id,
      NEW.id,
      COALESCE(NEW.hire_date, CURRENT_DATE),
      CASE WHEN NEW.is_active = FALSE THEN NEW.termination_date END,
      COALESCE(NEW.employment_type, 'full_time'),
      CASE WHEN NEW.is_active = FALSE THEN 'terminated' ELSE 'active' END,
      CASE WHEN NEW.is_active = FALSE THEN 'other' END,
      TRUE
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS employees_auto_employment ON public.employees;
CREATE TRIGGER employees_auto_employment
  AFTER INSERT ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.auto_create_employment_on_employee_insert();
