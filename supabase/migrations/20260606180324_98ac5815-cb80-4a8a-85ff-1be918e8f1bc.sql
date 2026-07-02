
CREATE OR REPLACE FUNCTION public.payroll_runs_immutability_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_stack text;
BEGIN
  IF COALESCE(OLD.status,'') NOT IN ('posted','paid','reversed') THEN
    RETURN NEW;
  END IF;

  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  IF v_stack ~* 'payroll_reverse_run_atomic|payroll_reclassify_run' THEN
    RETURN NEW;
  END IF;

  IF NEW.total_gross                  IS DISTINCT FROM OLD.total_gross
  OR NEW.total_other_deductions       IS DISTINCT FROM OLD.total_other_deductions
  OR NEW.total_employer_contributions IS DISTINCT FROM OLD.total_employer_contributions
  OR NEW.total_net                    IS DISTINCT FROM OLD.total_net
  OR NEW.employee_count               IS DISTINCT FROM OLD.employee_count
  OR NEW.pay_period_start             IS DISTINCT FROM OLD.pay_period_start
  OR NEW.pay_period_end               IS DISTINCT FROM OLD.pay_period_end
  OR NEW.run_type                     IS DISTINCT FROM OLD.run_type
  OR NEW.organization_id              IS DISTINCT FROM OLD.organization_id
  OR NEW.business_id                  IS DISTINCT FROM OLD.business_id
  THEN
    RAISE EXCEPTION
      'Payroll run % is % and its financial fields are immutable. Use a reversal or correction run instead.',
      OLD.payroll_number, OLD.status
      USING ERRCODE = '42501', HINT = 'payroll_run_immutable';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_payroll_runs_immutable ON public.payroll_runs;
CREATE TRIGGER trg_payroll_runs_immutable
BEFORE UPDATE ON public.payroll_runs
FOR EACH ROW EXECUTE FUNCTION public.payroll_runs_immutability_guard();

CREATE OR REPLACE FUNCTION public.payslips_immutability_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_stack      text;
  v_run_status text;
  v_run_id     uuid;
BEGIN
  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  IF v_stack ~* 'payroll_reverse_run_atomic|payroll_reclassify_run' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_run_id := COALESCE(OLD.payroll_run_id, NEW.payroll_run_id);
  SELECT status INTO v_run_status FROM public.payroll_runs WHERE id = v_run_id;
  IF v_run_status IS NULL OR v_run_status NOT IN ('posted','paid','reversed') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Payslip on a % payroll run cannot be deleted. Use the reversal flow.', v_run_status
      USING ERRCODE = '42501', HINT = 'payslip_immutable';
  END IF;

  -- Payment-batch path may stamp payment columns (status, paid_at, payment_reference, etc.).
  IF COALESCE(current_setting('app.payroll_payment_via_batch', true),'') = 'on' THEN
    IF NEW.basic_salary     IS DISTINCT FROM OLD.basic_salary
    OR NEW.gross_pay        IS DISTINCT FROM OLD.gross_pay
    OR NEW.net_pay          IS DISTINCT FROM OLD.net_pay
    OR NEW.taxable_income   IS DISTINCT FROM OLD.taxable_income
    OR NEW.paye             IS DISTINCT FROM OLD.paye
    OR NEW.nssf_employee    IS DISTINCT FROM OLD.nssf_employee
    OR NEW.nhif             IS DISTINCT FROM OLD.nhif
    OR NEW.housing_levy     IS DISTINCT FROM OLD.housing_levy
    OR NEW.employee_id      IS DISTINCT FROM OLD.employee_id
    OR NEW.payroll_run_id   IS DISTINCT FROM OLD.payroll_run_id
    THEN
      RAISE EXCEPTION
        'Payslip on a % payroll run cannot be edited.', v_run_status
        USING ERRCODE = '42501', HINT = 'payslip_immutable';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Payslip on a % payroll run is immutable. Use a reversal/correction run instead.', v_run_status
    USING ERRCODE = '42501', HINT = 'payslip_immutable';
END;
$function$;

DROP TRIGGER IF EXISTS trg_payslips_immutable_upd ON public.payslips;
CREATE TRIGGER trg_payslips_immutable_upd
BEFORE UPDATE ON public.payslips
FOR EACH ROW EXECUTE FUNCTION public.payslips_immutability_guard();

DROP TRIGGER IF EXISTS trg_payslips_immutable_del ON public.payslips;
CREATE TRIGGER trg_payslips_immutable_del
BEFORE DELETE ON public.payslips
FOR EACH ROW EXECUTE FUNCTION public.payslips_immutability_guard();

CREATE OR REPLACE FUNCTION public.payslip_lines_immutability_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_stack      text;
  v_run_status text;
  v_payslip    uuid := COALESCE(OLD.payslip_id, NEW.payslip_id);
BEGIN
  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  IF v_stack ~* 'payroll_reverse_run_atomic|payroll_reclassify_run' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT r.status INTO v_run_status
  FROM public.payslips p
  JOIN public.payroll_runs r ON r.id = p.payroll_run_id
  WHERE p.id = v_payslip;

  IF v_run_status IS NULL OR v_run_status NOT IN ('posted','paid','reversed') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION
    'Payslip line on a % payroll run is immutable. Use a reversal/correction run instead.', v_run_status
    USING ERRCODE = '42501', HINT = 'payslip_line_immutable';
END;
$function$;

DROP TRIGGER IF EXISTS trg_payslip_lines_immutable_upd ON public.payslip_lines;
CREATE TRIGGER trg_payslip_lines_immutable_upd
BEFORE UPDATE ON public.payslip_lines
FOR EACH ROW EXECUTE FUNCTION public.payslip_lines_immutability_guard();

DROP TRIGGER IF EXISTS trg_payslip_lines_immutable_del ON public.payslip_lines;
CREATE TRIGGER trg_payslip_lines_immutable_del
BEFORE DELETE ON public.payslip_lines
FOR EACH ROW EXECUTE FUNCTION public.payslip_lines_immutability_guard();
