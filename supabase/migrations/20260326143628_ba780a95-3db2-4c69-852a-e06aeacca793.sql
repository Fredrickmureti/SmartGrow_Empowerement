
-- Atomic function to process all loan deductions for a payroll run in a single transaction.
-- If ANY deduction fails, ALL are rolled back — no partial state.
CREATE OR REPLACE FUNCTION public.process_payroll_loan_deductions(
  _payroll_run_id UUID,
  _payroll_number TEXT,
  _deductions JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _ld JSONB;
  _loan_state RECORD;
  _new_repaid NUMERIC;
  _new_balance NUMERIC;
  _new_installments INTEGER;
BEGIN
  FOR _ld IN SELECT * FROM jsonb_array_elements(_deductions)
  LOOP
    -- Read current loan state
    SELECT amount_repaid, total_amount, installments_paid
    INTO _loan_state
    FROM employee_loans
    WHERE id = (_ld->>'loan_id')::UUID
    FOR UPDATE; -- Row lock to prevent concurrent modifications

    IF _loan_state IS NULL THEN
      RAISE EXCEPTION 'Loan % not found', _ld->>'loan_id';
    END IF;

    _new_repaid := COALESCE(_loan_state.amount_repaid, 0) + (_ld->>'amount')::NUMERIC;
    _new_balance := _loan_state.total_amount - _new_repaid;
    _new_installments := COALESCE(_loan_state.installments_paid, 0) + 1;

    -- Insert repayment record
    INSERT INTO loan_repayments (loan_id, payroll_run_id, amount, installment_number, notes)
    VALUES (
      (_ld->>'loan_id')::UUID,
      _payroll_run_id,
      (_ld->>'amount')::NUMERIC,
      _new_installments,
      'Auto-deducted via payroll ' || _payroll_number
    );

    -- Update loan balance
    UPDATE employee_loans
    SET amount_repaid = _new_repaid,
        outstanding_balance = GREATEST(0, _new_balance),
        installments_paid = _new_installments,
        status = CASE WHEN _new_balance <= 0 THEN 'completed' ELSE 'active' END
    WHERE id = (_ld->>'loan_id')::UUID;
  END LOOP;
END;
$$;
