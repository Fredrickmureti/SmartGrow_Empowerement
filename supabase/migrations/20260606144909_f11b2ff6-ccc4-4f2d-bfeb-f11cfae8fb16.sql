
-- =====================================================================
-- M2 — Auto-capture compensation history on changes
-- =====================================================================

CREATE OR REPLACE FUNCTION public.log_employee_compensation_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_changed boolean := false;
  v_alw jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_changed := COALESCE(NEW.basic_salary, 0) > 0
                 OR COALESCE(NEW.housing_allowance, 0) > 0
                 OR COALESCE(NEW.transport_allowance, 0) > 0;
  ELSE
    v_changed := COALESCE(NEW.basic_salary, 0) IS DISTINCT FROM COALESCE(OLD.basic_salary, 0)
              OR COALESCE(NEW.housing_allowance, 0) IS DISTINCT FROM COALESCE(OLD.housing_allowance, 0)
              OR COALESCE(NEW.transport_allowance, 0) IS DISTINCT FROM COALESCE(OLD.transport_allowance, 0);
  END IF;

  IF NOT v_changed THEN
    RETURN NEW;
  END IF;

  v_alw := jsonb_build_object(
    'housing_allowance', COALESCE(NEW.housing_allowance, 0),
    'transport_allowance', COALESCE(NEW.transport_allowance, 0),
    'other_allowances', COALESCE(NEW.other_allowances, 0)
  );

  INSERT INTO public.employee_compensation_history(
    organization_id, business_id, employee_id, effective_date,
    basic_salary, allowances_json, change_type, reason, created_by
  ) VALUES (
    NEW.organization_id,
    NEW.business_id,
    NEW.id,
    CURRENT_DATE,
    COALESCE(NEW.basic_salary, 0),
    v_alw,
    CASE WHEN TG_OP = 'INSERT' THEN 'initial' ELSE 'adjustment' END,
    CASE WHEN TG_OP = 'INSERT' THEN 'Hire' ELSE 'Salary/allowance change' END,
    auth.uid()
  );

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_log_employee_compensation_change ON public.employees;
CREATE TRIGGER trg_log_employee_compensation_change
  AFTER INSERT OR UPDATE OF basic_salary, housing_allowance, transport_allowance, other_allowances
  ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.log_employee_compensation_change();

COMMENT ON FUNCTION public.log_employee_compensation_change() IS
  'M2: snapshots an employees row into employee_compensation_history whenever pay components change.';
