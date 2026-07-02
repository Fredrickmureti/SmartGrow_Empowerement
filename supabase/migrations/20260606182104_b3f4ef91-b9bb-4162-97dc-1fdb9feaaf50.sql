
-- C-PAY-4-FIX: country-agnostic payslip immutability trigger
-- Replaces the broken guard that referenced non-existent Kenya-specific
-- columns (paye/nhif/nssf_employee/housing_levy) on public.payslips.
-- New guard locks only generic columns and allow-lists payment-batch
-- stamps to {status, paid_at, payment_reference, updated_at}.

CREATE OR REPLACE FUNCTION public.payslips_immutability_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_stack        text;
  v_run_status   text;
  v_run_id       uuid;
  v_batch_bypass boolean;
BEGIN
  -- Reversal / reclassification RPCs are the only writers allowed to
  -- mutate a frozen payslip's financial state.
  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  IF v_stack ~* 'payroll_reverse_run_atomic|payroll_reclassify_run' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_run_id := COALESCE(OLD.payroll_run_id, NEW.payroll_run_id);
  SELECT status INTO v_run_status FROM public.payroll_runs WHERE id = v_run_id;

  -- Only frozen statuses are immutable.
  IF v_run_status IS NULL OR v_run_status NOT IN ('posted','paid','reversed') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Payslip on a % payroll run cannot be deleted. Use the reversal flow.', v_run_status
      USING ERRCODE = '42501', HINT = 'payslip_immutable';
  END IF;

  v_batch_bypass := COALESCE(current_setting('app.payroll_payment_via_batch', true),'') = 'on';

  -- Payment-batch path: only stamp payment-confirmation columns.
  -- Any change outside {status, paid_at, payment_reference, updated_at} is rejected.
  IF v_batch_bypass THEN
    IF NEW.basic_salary          IS DISTINCT FROM OLD.basic_salary
    OR NEW.gross_pay             IS DISTINCT FROM OLD.gross_pay
    OR NEW.net_pay               IS DISTINCT FROM OLD.net_pay
    OR NEW.taxable_income        IS DISTINCT FROM OLD.taxable_income
    OR NEW.total_deductions      IS DISTINCT FROM OLD.total_deductions
    OR NEW.other_earnings        IS DISTINCT FROM OLD.other_earnings
    OR NEW.other_deductions      IS DISTINCT FROM OLD.other_deductions
    OR NEW.deductions_detail     IS DISTINCT FROM OLD.deductions_detail
    OR NEW.contributions_detail  IS DISTINCT FROM OLD.contributions_detail
    OR NEW.unpaid_leave_days     IS DISTINCT FROM OLD.unpaid_leave_days
    OR NEW.leave_deduction       IS DISTINCT FROM OLD.leave_deduction
    OR NEW.employee_id           IS DISTINCT FROM OLD.employee_id
    OR NEW.payroll_run_id        IS DISTINCT FROM OLD.payroll_run_id
    OR NEW.organization_id       IS DISTINCT FROM OLD.organization_id
    OR NEW.business_id           IS DISTINCT FROM OLD.business_id
    OR NEW.branch_id             IS DISTINCT FROM OLD.branch_id
    OR NEW.payslip_number        IS DISTINCT FROM OLD.payslip_number
    OR NEW.rule_set_id           IS DISTINCT FROM OLD.rule_set_id
    OR NEW.rule_set_version      IS DISTINCT FROM OLD.rule_set_version
    OR NEW.rule_set_hash         IS DISTINCT FROM OLD.rule_set_hash
    THEN
      RAISE EXCEPTION
        'Payslip on a % payroll run cannot be edited via the payment-batch path. Only payment-confirmation columns (status, paid_at, payment_reference) may change.', v_run_status
        USING ERRCODE = '42501', HINT = 'payslip_immutable';
    END IF;
    RETURN NEW;
  END IF;

  -- No bypass: any UPDATE is rejected.
  RAISE EXCEPTION
    'Payslip on a % payroll run is immutable. Use a reversal/correction run instead.', v_run_status
    USING ERRCODE = '42501', HINT = 'payslip_immutable';
END;
$function$;

-- Also clean up the payroll_runs guard: the existing function is fine, but
-- ensure it does not reference any country-specific columns (it didn't —
-- this is a no-op re-define for posterity / search-path hardening).
-- (Left as-is; we only re-attach the trigger to be safe.)
DROP TRIGGER IF EXISTS trg_payslips_immutable_upd ON public.payslips;
CREATE TRIGGER trg_payslips_immutable_upd
BEFORE UPDATE ON public.payslips
FOR EACH ROW EXECUTE FUNCTION public.payslips_immutability_guard();

DROP TRIGGER IF EXISTS trg_payslips_immutable_del ON public.payslips;
CREATE TRIGGER trg_payslips_immutable_del
BEFORE DELETE ON public.payslips
FOR EACH ROW EXECUTE FUNCTION public.payslips_immutability_guard();
