CREATE OR REPLACE FUNCTION public.guard_loan_skip_override_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.status = 'approved' AND COALESCE(OLD.status,'') <> 'approved'
     AND NEW.approved_by IS NOT NULL THEN
    PERFORM public.governance_assert_not_self(
      NEW.approved_by, NEW.created_by, 'payroll.loan_skip_override.approve',
      NEW.organization_id, 'payroll_run_loan_skip_override', NEW.id
    );
  END IF;

  IF NEW.status = 'rejected' AND COALESCE(OLD.status,'') <> 'rejected'
     AND NEW.rejected_by IS NOT NULL THEN
    PERFORM public.governance_assert_not_self(
      NEW.rejected_by, NEW.created_by, 'payroll.loan_skip_override.reject',
      NEW.organization_id, 'payroll_run_loan_skip_override', NEW.id
    );
  END IF;

  IF NEW.status = 'cancelled' AND COALESCE(OLD.status,'') <> 'cancelled'
     AND NEW.cancelled_by IS NOT NULL AND OLD.approved_by IS NOT NULL THEN
    PERFORM public.governance_assert_not_self(
      NEW.cancelled_by, OLD.approved_by, 'payroll.loan_skip_override.cancel',
      NEW.organization_id, 'payroll_run_loan_skip_override', NEW.id
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sod_payroll_run_loan_skip_overrides_guard ON public.payroll_run_loan_skip_overrides;
CREATE TRIGGER sod_payroll_run_loan_skip_overrides_guard
  BEFORE UPDATE ON public.payroll_run_loan_skip_overrides
  FOR EACH ROW EXECUTE FUNCTION public.guard_loan_skip_override_self_approval();