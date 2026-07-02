
ALTER TABLE public.payslips ADD COLUMN IF NOT EXISTS payslip_number text;

-- Backfill existing rows: {payroll_number}/{employee_number or short id}
UPDATE public.payslips ps
SET payslip_number = pr.payroll_number || '/' || COALESCE(NULLIF(e.employee_number, ''), 'EMP-' || substr(ps.employee_id::text, 1, 8))
FROM public.payroll_runs pr, public.employees e
WHERE ps.payroll_run_id = pr.id
  AND ps.employee_id = e.id
  AND ps.payslip_number IS NULL;

-- Trigger to auto-generate on insert if missing
CREATE OR REPLACE FUNCTION public.set_payslip_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payroll_number text;
  v_employee_number text;
BEGIN
  IF NEW.payslip_number IS NOT NULL AND NEW.payslip_number <> '' THEN
    RETURN NEW;
  END IF;

  SELECT payroll_number INTO v_payroll_number FROM public.payroll_runs WHERE id = NEW.payroll_run_id;
  SELECT NULLIF(employee_number, '') INTO v_employee_number FROM public.employees WHERE id = NEW.employee_id;

  NEW.payslip_number := COALESCE(v_payroll_number, 'PSL-' || to_char(now(), 'YYYYMM'))
                        || '/'
                        || COALESCE(v_employee_number, 'EMP-' || substr(NEW.employee_id::text, 1, 8));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_payslip_number ON public.payslips;
CREATE TRIGGER trg_set_payslip_number
BEFORE INSERT ON public.payslips
FOR EACH ROW EXECUTE FUNCTION public.set_payslip_number();

CREATE UNIQUE INDEX IF NOT EXISTS payslips_org_number_unique
  ON public.payslips (organization_id, payslip_number);
