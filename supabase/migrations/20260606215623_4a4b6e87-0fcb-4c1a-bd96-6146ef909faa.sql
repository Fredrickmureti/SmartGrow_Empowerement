
-- TURN B (Wave 3.5) — Payroll re-open guard.
-- Once employees.lifecycle_status = 'archived', no new payslip can be inserted
-- for that employee on any payroll run whose status is not yet final
-- ('draft','computed','approved' all blocked; only historical insertions onto
-- already-posted runs are theoretically possible, but those are already gated
-- by trg_payslip_run_immutability — so this trigger covers the open-run gap).

CREATE OR REPLACE FUNCTION public.payslip_block_archived_employee()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_run_status TEXT;
BEGIN
  SELECT lifecycle_status INTO v_status
    FROM public.employees
    WHERE id = NEW.employee_id;

  IF v_status IS DISTINCT FROM 'archived' THEN
    RETURN NEW;
  END IF;

  SELECT status INTO v_run_status
    FROM public.payroll_runs
    WHERE id = NEW.payroll_run_id;

  -- Allow inserts ONLY on terminal-history states. Block every open state.
  IF v_run_status IN ('posted','paid','reversed','final_settlement') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Cannot add a new payslip for archived employee % to an open payroll run (run status: %).',
    NEW.employee_id, COALESCE(v_run_status, 'unknown')
    USING ERRCODE = '42501',
          HINT    = 'payroll_employee_archived';
END;
$$;

DROP TRIGGER IF EXISTS trg_payslip_block_archived_employee ON public.payslips;
CREATE TRIGGER trg_payslip_block_archived_employee
  BEFORE INSERT ON public.payslips
  FOR EACH ROW EXECUTE FUNCTION public.payslip_block_archived_employee();

COMMENT ON FUNCTION public.payslip_block_archived_employee IS
  'Wave 3.5 reopen guard: prevents new payslips for archived employees on any non-terminal payroll run. Closes the appendix-3.5 gap. Raises 42501 with HINT payroll_employee_archived.';
