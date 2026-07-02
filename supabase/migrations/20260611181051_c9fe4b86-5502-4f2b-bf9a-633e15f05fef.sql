
-- =========================================================================
-- SoD Wave G2 — Migration 3: status-transition self-approval triggers
-- =========================================================================

-- Helper: shared status set for "approved-equivalent" transitions.
CREATE OR REPLACE FUNCTION public._sod_is_approved_status(s text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT COALESCE(lower(s),'') IN (
    'approved','posted','finalized','finalised','paid','processed','completed',
    'in_transit','authorized','authorised','closed','reconciled','sent_for_payment',
    'pending_second_approval','active'
  )
$$;

-- =========================================================================
-- Per-table guards (BEFORE UPDATE).
-- =========================================================================

-- ----- stock_adjustments --------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_stock_adjustment_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF public._sod_is_approved_status(NEW.status)
     AND NOT public._sod_is_approved_status(COALESCE(OLD.status,'')) THEN
    IF NEW.approved_by IS NULL THEN
      RAISE EXCEPTION 'Approval requires an approver (approved_by must be set).'
        USING ERRCODE = '42501', HINT = 'GOV_APPROVER_REQUIRED';
    END IF;
    PERFORM public.governance_assert_not_self(
      NEW.approved_by, NEW.created_by, 'inventory.approve_adjustment',
      NEW.organization_id, 'stock_adjustment', NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sod_stock_adjustments_guard ON public.stock_adjustments;
CREATE TRIGGER sod_stock_adjustments_guard
  BEFORE UPDATE ON public.stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.guard_stock_adjustment_self_approval();

-- ----- stock_transfers ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_stock_transfer_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF public._sod_is_approved_status(NEW.status)
     AND NOT public._sod_is_approved_status(COALESCE(OLD.status,'')) THEN
    IF NEW.approved_by IS NULL THEN
      RAISE EXCEPTION 'Approval requires an approver (approved_by must be set).'
        USING ERRCODE = '42501', HINT = 'GOV_APPROVER_REQUIRED';
    END IF;
    PERFORM public.governance_assert_not_self(
      NEW.approved_by, NEW.requested_by, 'inventory.approve_transfer',
      NEW.organization_id, 'stock_transfer', NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sod_stock_transfers_guard ON public.stock_transfers;
CREATE TRIGGER sod_stock_transfers_guard
  BEFORE UPDATE ON public.stock_transfers
  FOR EACH ROW EXECUTE FUNCTION public.guard_stock_transfer_self_approval();

-- ----- leave_requests -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_leave_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_subject uuid;
BEGIN
  IF NEW.status NOT IN ('approved','pending_second_approval') THEN RETURN NEW; END IF;
  IF COALESCE(OLD.status,'') = NEW.status THEN RETURN NEW; END IF;

  SELECT user_id INTO v_subject FROM public.employees WHERE id = NEW.employee_id;

  IF NEW.first_approver_id IS NOT NULL AND v_subject IS NOT NULL THEN
    PERFORM public.governance_assert_not_self(
      NEW.first_approver_id, v_subject, 'leave.approve',
      NEW.organization_id, 'leave_request', NEW.id
    );
  END IF;

  IF NEW.second_approver_id IS NOT NULL
     AND NEW.second_approver_id IS DISTINCT FROM OLD.second_approver_id THEN
    IF v_subject IS NOT NULL THEN
      PERFORM public.governance_assert_not_self(
        NEW.second_approver_id, v_subject, 'leave.approve_l2',
        NEW.organization_id, 'leave_request', NEW.id
      );
    END IF;
    IF NEW.first_approver_id IS NOT NULL AND NEW.second_approver_id = NEW.first_approver_id THEN
      RAISE EXCEPTION 'Second-level approver must differ from first-level approver.'
        USING ERRCODE = '42501', HINT = 'GOV_SELF_ACTION';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sod_leave_requests_guard ON public.leave_requests;
CREATE TRIGGER sod_leave_requests_guard
  BEFORE UPDATE ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_leave_self_approval();

-- ----- timesheet_submissions ----------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_timesheet_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_subject uuid;
BEGIN
  IF COALESCE(NEW.approved_by, '00000000-0000-0000-0000-000000000000'::uuid)
     = COALESCE(OLD.approved_by, '00000000-0000-0000-0000-000000000000'::uuid) THEN
    RETURN NEW;
  END IF;
  IF NEW.approved_by IS NULL THEN RETURN NEW; END IF;
  SELECT user_id INTO v_subject FROM public.employees WHERE id = NEW.employee_id;
  IF v_subject IS NOT NULL THEN
    PERFORM public.governance_assert_not_self(
      NEW.approved_by, v_subject, 'timesheet.approve',
      NULL, 'timesheet_submission', NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sod_timesheet_submissions_guard ON public.timesheet_submissions;
CREATE TRIGGER sod_timesheet_submissions_guard
  BEFORE UPDATE ON public.timesheet_submissions
  FOR EACH ROW EXECUTE FUNCTION public.guard_timesheet_self_approval();

-- ----- employee_loans -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_employee_loan_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF public._sod_is_approved_status(NEW.status)
     AND NOT public._sod_is_approved_status(COALESCE(OLD.status,'')) THEN
    IF NEW.approved_by IS NULL THEN
      RAISE EXCEPTION 'Loan approval requires an approver (approved_by must be set).'
        USING ERRCODE = '42501', HINT = 'GOV_APPROVER_REQUIRED';
    END IF;
    PERFORM public.governance_assert_not_self(
      NEW.approved_by, COALESCE(NEW.requested_by, NEW.created_by), 'loan.approve',
      NEW.organization_id, 'employee_loan', NEW.id
    );
    PERFORM public.governance_assert_not_subject(
      NEW.approved_by, NEW.employee_id, 'loan.approve_self_benefit',
      NEW.organization_id, 'employee_loan', NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sod_employee_loans_guard ON public.employee_loans;
CREATE TRIGGER sod_employee_loans_guard
  BEFORE UPDATE ON public.employee_loans
  FOR EACH ROW EXECUTE FUNCTION public.guard_employee_loan_self_approval();

-- ----- employee_compensation_history (no status column) -------------------
CREATE OR REPLACE FUNCTION public.guard_compensation_change_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.approved_by IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    PERFORM public.governance_assert_not_self(
      NEW.approved_by, NEW.created_by, 'compensation.approve',
      NEW.organization_id, 'employee_compensation_history', NEW.id
    );
    PERFORM public.governance_assert_not_subject(
      NEW.approved_by, NEW.employee_id, 'compensation.approve_self_benefit',
      NEW.organization_id, 'employee_compensation_history', NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sod_compensation_history_guard ON public.employee_compensation_history;
CREATE TRIGGER sod_compensation_history_guard
  BEFORE INSERT OR UPDATE ON public.employee_compensation_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_compensation_change_self_approval();

-- ----- employee_contracts -------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_employee_contract_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF public._sod_is_approved_status(NEW.status)
     AND NOT public._sod_is_approved_status(COALESCE(OLD.status,'')) THEN
    IF NEW.approved_by IS NOT NULL THEN
      PERFORM public.governance_assert_not_self(
        NEW.approved_by, NEW.created_by, 'contract.approve',
        NEW.organization_id, 'employee_contract', NEW.id
      );
      PERFORM public.governance_assert_not_subject(
        NEW.approved_by, NEW.employee_id, 'contract.approve_self_benefit',
        NEW.organization_id, 'employee_contract', NEW.id
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sod_employee_contracts_guard ON public.employee_contracts;
CREATE TRIGGER sod_employee_contracts_guard
  BEFORE UPDATE ON public.employee_contracts
  FOR EACH ROW EXECUTE FUNCTION public.guard_employee_contract_self_approval();

-- ----- bills --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_bill_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF public._sod_is_approved_status(NEW.status)
     AND NOT public._sod_is_approved_status(COALESCE(OLD.status,'')) THEN
    IF NEW.approved_by IS NOT NULL THEN
      PERFORM public.governance_assert_not_self(
        NEW.approved_by, NEW.created_by, 'bill.approve',
        NEW.organization_id, 'bill', NEW.id
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sod_bills_guard ON public.bills;
CREATE TRIGGER sod_bills_guard
  BEFORE UPDATE ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public.guard_bill_self_approval();

-- ----- bill_payments (no status) ------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_bill_payment_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.approved_by IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    PERFORM public.governance_assert_not_self(
      NEW.approved_by, NEW.created_by, 'bill_payment.approve',
      NEW.organization_id, 'bill_payment', NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sod_bill_payments_guard ON public.bill_payments;
CREATE TRIGGER sod_bill_payments_guard
  BEFORE INSERT OR UPDATE ON public.bill_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_bill_payment_self_approval();

-- ----- payments -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_payment_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF public._sod_is_approved_status(NEW.status)
     AND NOT public._sod_is_approved_status(COALESCE(OLD.status,'')) THEN
    IF NEW.approved_by IS NOT NULL THEN
      PERFORM public.governance_assert_not_self(
        NEW.approved_by, NEW.created_by, 'payment.approve',
        NEW.organization_id, 'payment', NEW.id
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sod_payments_guard ON public.payments;
CREATE TRIGGER sod_payments_guard
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_payment_self_approval();

-- ----- journal_entries ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_journal_entry_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF public._sod_is_approved_status(NEW.status)
     AND NOT public._sod_is_approved_status(COALESCE(OLD.status,'')) THEN
    IF NEW.approved_by IS NOT NULL THEN
      PERFORM public.governance_assert_not_self(
        NEW.approved_by, NEW.created_by, 'journal.post',
        NEW.organization_id, 'journal_entry', NEW.id
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sod_journal_entries_guard ON public.journal_entries;
CREATE TRIGGER sod_journal_entries_guard
  BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_journal_entry_self_approval();

-- ----- purchase_orders ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_purchase_order_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF public._sod_is_approved_status(NEW.status)
     AND NOT public._sod_is_approved_status(COALESCE(OLD.status,'')) THEN
    IF NEW.approved_by IS NOT NULL THEN
      PERFORM public.governance_assert_not_self(
        NEW.approved_by, NEW.created_by, 'purchase_order.approve',
        NEW.organization_id, 'purchase_order', NEW.id
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sod_purchase_orders_guard ON public.purchase_orders;
CREATE TRIGGER sod_purchase_orders_guard
  BEFORE UPDATE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_purchase_order_self_approval();

-- ----- expenses (employee + self-benefit) ---------------------------------
CREATE OR REPLACE FUNCTION public.guard_expense_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF public._sod_is_approved_status(NEW.status)
     AND NOT public._sod_is_approved_status(COALESCE(OLD.status,'')) THEN
    IF NEW.approved_by IS NOT NULL THEN
      PERFORM public.governance_assert_not_self(
        NEW.approved_by, NEW.created_by, 'expense.approve',
        NEW.organization_id, 'expense', NEW.id
      );
      IF NEW.employee_id IS NOT NULL THEN
        PERFORM public.governance_assert_not_subject(
          NEW.approved_by, NEW.employee_id, 'expense.approve_self_benefit',
          NEW.organization_id, 'expense', NEW.id
        );
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sod_expenses_guard ON public.expenses;
CREATE TRIGGER sod_expenses_guard
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.guard_expense_self_approval();

-- ----- customer_refunds ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_customer_refund_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF public._sod_is_approved_status(NEW.status)
     AND NOT public._sod_is_approved_status(COALESCE(OLD.status,'')) THEN
    IF NEW.approved_by IS NOT NULL THEN
      PERFORM public.governance_assert_not_self(
        NEW.approved_by, NEW.created_by, 'customer_refund.approve',
        NEW.organization_id, 'customer_refund', NEW.id
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sod_customer_refunds_guard ON public.customer_refunds;
CREATE TRIGGER sod_customer_refunds_guard
  BEFORE UPDATE ON public.customer_refunds
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_refund_self_approval();

-- ----- vendor_credit_notes ------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_vendor_credit_note_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF public._sod_is_approved_status(NEW.status)
     AND NOT public._sod_is_approved_status(COALESCE(OLD.status,'')) THEN
    IF NEW.approved_by IS NOT NULL THEN
      PERFORM public.governance_assert_not_self(
        NEW.approved_by, NEW.created_by, 'vendor_credit_note.approve',
        NEW.organization_id, 'vendor_credit_note', NEW.id
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sod_vendor_credit_notes_guard ON public.vendor_credit_notes;
CREATE TRIGGER sod_vendor_credit_notes_guard
  BEFORE UPDATE ON public.vendor_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.guard_vendor_credit_note_self_approval();

-- ----- credit_notes (sales) -----------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_credit_note_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF public._sod_is_approved_status(NEW.status)
     AND NOT public._sod_is_approved_status(COALESCE(OLD.status,'')) THEN
    IF NEW.approved_by IS NOT NULL THEN
      PERFORM public.governance_assert_not_self(
        NEW.approved_by, NEW.created_by, 'credit_note.approve',
        NEW.organization_id, 'credit_note', NEW.id
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sod_credit_notes_guard ON public.credit_notes;
CREATE TRIGGER sod_credit_notes_guard
  BEFORE UPDATE ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.guard_credit_note_self_approval();

-- ----- payroll_runs: keep existing maker-checker, also consult new policy --
-- Replace enforce_payroll_maker_checker to route through governance_assert_not_self
-- so the same policy registry governs payroll.
CREATE OR REPLACE FUNCTION public.enforce_payroll_maker_checker()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_has_approve boolean := false;
BEGIN
  IF TG_OP <> 'UPDATE'
     OR NEW.status NOT IN ('approved','posted','finalized')
     OR COALESCE(OLD.status,'') IN ('approved','posted','finalized') THEN
    RETURN NEW;
  END IF;

  IF NEW.approved_by IS NULL THEN
    RAISE EXCEPTION 'Payroll approval requires an approver (approved_by must be set).'
      USING ERRCODE = '42501', HINT = 'GOV_APPROVER_REQUIRED';
  END IF;

  v_has_approve := public.user_has_module_permission(
    NEW.approved_by, NEW.organization_id, 'payroll', 'approve'
  );
  IF NOT v_has_approve THEN
    RAISE EXCEPTION 'Approver lacks payroll.approve permission. Grant it via Access Groups or assign an admin/owner.'
      USING ERRCODE = '42501', HINT = 'GOV_MISSING_PERMISSION';
  END IF;

  PERFORM public.governance_assert_not_self(
    NEW.approved_by, NEW.created_by, 'payroll.approve',
    NEW.organization_id, 'payroll_run', NEW.id
  );

  RETURN NEW;
END;
$$;
