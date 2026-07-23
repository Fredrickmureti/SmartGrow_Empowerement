
-- =====================================================================
-- payslip_bucket — SQL mirror of _shared/payslipClassifier.ts.
-- Kept immutable + strict so it can safely appear inside triggers,
-- indexes, and generated columns without surprising the planner.
-- Any change here MUST be paired with a change to the two TS mirrors
-- (supabase/functions/_shared/payslipClassifier.ts and
-- src/lib/payroll/payslipClassifier.ts).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.payslip_bucket(cat text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(coalesce(cat, ''))
    WHEN 'earning'               THEN 'earning'
    WHEN 'basic'                 THEN 'earning'
    WHEN 'allowance'             THEN 'earning'
    WHEN 'bonus'                 THEN 'earning'
    WHEN 'overtime'              THEN 'earning'
    WHEN 'reimbursement'         THEN 'earning'

    WHEN 'deduction'             THEN 'deduction'
    WHEN 'pre_tax_deduction'     THEN 'deduction'
    WHEN 'post_tax_deduction'    THEN 'deduction'
    WHEN 'statutory_employee'    THEN 'deduction'
    WHEN 'tax'                   THEN 'deduction'
    WHEN 'income_tax'            THEN 'deduction'
    WHEN 'loan_repayment'        THEN 'deduction'
    WHEN 'benefit_recovery'      THEN 'deduction'
    WHEN 'voluntary_deduction'   THEN 'deduction'
    WHEN 'garnishment'           THEN 'deduction'

    WHEN 'employer_contribution' THEN 'employer_contribution'
    WHEN 'statutory_employer'    THEN 'employer_contribution'
    WHEN 'training_levy'         THEN 'employer_contribution'
    WHEN 'pension_employer'      THEN 'employer_contribution'

    ELSE 'info'
  END;
$$;

COMMENT ON FUNCTION public.payslip_bucket(text) IS
  'Canonical payslip-line category bucket. TS classifiers must mirror this. '
  'Adding a new category means updating this function AND the two TS mirrors '
  'in the same PR.';

-- =====================================================================
-- payslips_totals_match_lines — architectural guard.
-- Rejects a payslip whose header totals disagree with what the lines
-- actually sum to. This makes it structurally impossible for a
-- deduction (e.g. a legal-order garnishment) to influence Total
-- Deductions / Net Pay while being absent from payslip_lines.
--
-- Only enforced once the payslip has left the `draft` phase — during
-- draft the engine may write the header first and lines after, and we
-- don't want to force ordering on the insert path.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.enforce_payslip_totals_match_lines()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_earn      numeric := 0;
  v_ded       numeric := 0;
  v_emp_contrib numeric := 0;
  v_tol       numeric := 0.01;
BEGIN
  -- Skip the guard while the payslip is still being built.
  IF coalesce(NEW.status, '') = 'draft' THEN
    RETURN NEW;
  END IF;

  SELECT
    coalesce(sum(employee_amount) FILTER (WHERE public.payslip_bucket(category) = 'earning'),   0),
    coalesce(sum(employee_amount) FILTER (WHERE public.payslip_bucket(category) = 'deduction'), 0),
    coalesce(sum(employer_amount) FILTER (WHERE public.payslip_bucket(category) = 'employer_contribution'), 0)
  INTO v_earn, v_ded, v_emp_contrib
  FROM public.payslip_lines
  WHERE payslip_id = NEW.id;

  IF abs(coalesce(NEW.gross_pay, 0) - v_earn) > v_tol THEN
    RAISE EXCEPTION
      'PAYSLIP_HEADER_LINES_DRIFT: gross_pay=% but earning lines sum to % (delta=%). '
      'Every value on a payslip header MUST be represented by a payslip_lines row. '
      'Fix the engine to emit the missing line — do not patch the header.',
      NEW.gross_pay, v_earn, (NEW.gross_pay - v_earn)
      USING ERRCODE = 'check_violation';
  END IF;

  IF abs(coalesce(NEW.total_deductions, 0) - v_ded) > v_tol THEN
    RAISE EXCEPTION
      'PAYSLIP_HEADER_LINES_DRIFT: total_deductions=% but deduction lines sum to % (delta=%). '
      'A deduction is influencing the header total without a corresponding payslip_lines row. '
      'This is exactly the class of bug (silent garnishment/legal-order) this guard exists to prevent.',
      NEW.total_deductions, v_ded, (NEW.total_deductions - v_ded)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- Constraint trigger deferred to end-of-transaction so the engine can
-- INSERT the payslip header and its lines in either order within the
-- same transaction and still be validated once, right before COMMIT.
DROP TRIGGER IF EXISTS payslips_totals_match_lines ON public.payslips;
CREATE CONSTRAINT TRIGGER payslips_totals_match_lines
  AFTER INSERT OR UPDATE OF gross_pay, total_deductions, status
  ON public.payslips
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_payslip_totals_match_lines();
