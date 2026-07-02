
ALTER TABLE public.loan_types
  ADD COLUMN IF NOT EXISTS min_installments INTEGER,
  ADD COLUMN IF NOT EXISTS max_installments INTEGER,
  ADD COLUMN IF NOT EXISTS min_principal NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS max_principal NUMERIC(15,2);

ALTER TABLE public.loan_types
  DROP CONSTRAINT IF EXISTS loan_types_installments_bounds_chk;
ALTER TABLE public.loan_types
  ADD CONSTRAINT loan_types_installments_bounds_chk
  CHECK (
    min_installments IS NULL OR min_installments >= 1
  ) NOT VALID;

ALTER TABLE public.loan_types
  DROP CONSTRAINT IF EXISTS loan_types_installments_order_chk;
ALTER TABLE public.loan_types
  ADD CONSTRAINT loan_types_installments_order_chk
  CHECK (
    min_installments IS NULL
    OR max_installments IS NULL
    OR max_installments >= min_installments
  ) NOT VALID;

ALTER TABLE public.loan_types
  DROP CONSTRAINT IF EXISTS loan_types_principal_order_chk;
ALTER TABLE public.loan_types
  ADD CONSTRAINT loan_types_principal_order_chk
  CHECK (
    min_principal IS NULL
    OR max_principal IS NULL
    OR max_principal >= min_principal
  ) NOT VALID;

CREATE OR REPLACE FUNCTION public.enforce_loan_request_policy_bounds()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lt RECORD;
BEGIN
  -- Only enforce on the request/pending stages; HR approval can override.
  IF NEW.status NOT IN ('requested', 'pending_approval') THEN
    RETURN NEW;
  END IF;

  IF NEW.loan_type_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT min_installments, max_installments, min_principal, max_principal,
         default_repayment_method, name
    INTO lt
  FROM public.loan_types
  WHERE id = NEW.loan_type_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Principal bounds
  IF lt.min_principal IS NOT NULL AND NEW.principal_amount < lt.min_principal THEN
    RAISE EXCEPTION 'Loan amount % is below the minimum % allowed for loan type %',
      NEW.principal_amount, lt.min_principal, lt.name
      USING ERRCODE = 'check_violation';
  END IF;

  IF lt.max_principal IS NOT NULL AND NEW.principal_amount > lt.max_principal THEN
    RAISE EXCEPTION 'Loan amount % exceeds the maximum % allowed for loan type %',
      NEW.principal_amount, lt.max_principal, lt.name
      USING ERRCODE = 'check_violation';
  END IF;

  -- Installment bounds (skip for one-off advances)
  IF lt.default_repayment_method <> 'one_off_next_payroll' THEN
    IF lt.min_installments IS NOT NULL
       AND COALESCE(NEW.total_installments, 0) < lt.min_installments THEN
      RAISE EXCEPTION 'At least % installment(s) required for loan type %',
        lt.min_installments, lt.name
        USING ERRCODE = 'check_violation';
    END IF;

    IF lt.max_installments IS NOT NULL
       AND COALESCE(NEW.total_installments, 0) > lt.max_installments THEN
      RAISE EXCEPTION 'No more than % installment(s) allowed for loan type %',
        lt.max_installments, lt.name
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_loan_request_policy_bounds_trg ON public.employee_loans;
CREATE TRIGGER enforce_loan_request_policy_bounds_trg
BEFORE INSERT OR UPDATE OF principal_amount, total_installments, loan_type_id, status
ON public.employee_loans
FOR EACH ROW
EXECUTE FUNCTION public.enforce_loan_request_policy_bounds();

COMMENT ON FUNCTION public.enforce_loan_request_policy_bounds() IS
  'Validates loan requests against loan_types policy bounds (min/max principal and installments). Applies only to requested/pending_approval stages; HR can override on approval.';
