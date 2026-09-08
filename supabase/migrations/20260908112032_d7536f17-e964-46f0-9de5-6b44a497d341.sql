-- Loan balances: outstanding is only meaningful while the loan is on the book.
-- A closed, written-off, cancelled or reissue-settled loan carries no receivable
-- in the general ledger, so it must not carry one in the portfolio either.
CREATE OR REPLACE VIEW public.mf_loan_balances AS
 SELECT l.id AS loan_id,
    l.business_id,
    l.branch_id,
    l.client_id,
    l.loan_officer_id,
    l.loan_number,
    l.status,
    l.currency_code,
    l.principal,
    COALESCE(sum(i.principal_outstanding) FILTER (WHERE l.status IN ('active','pending_disbursement') AND l.settled_by_loan_id IS NULL), (0)::numeric) AS principal_outstanding,
    COALESCE(sum(i.interest_outstanding) FILTER (WHERE l.status IN ('active','pending_disbursement') AND l.settled_by_loan_id IS NULL), (0)::numeric) AS interest_outstanding,
    COALESCE(sum(i.fees_outstanding) FILTER (WHERE l.status IN ('active','pending_disbursement') AND l.settled_by_loan_id IS NULL), (0)::numeric) AS fees_outstanding,
    COALESCE(sum(i.total_outstanding) FILTER (WHERE l.status IN ('active','pending_disbursement') AND l.settled_by_loan_id IS NULL), (0)::numeric) AS total_outstanding,
    COALESCE(sum(i.total_due), (0)::numeric) AS total_contractual,
    COALESCE(sum(i.total_outstanding) FILTER (WHERE i.due_date < CURRENT_DATE AND l.status IN ('active','pending_disbursement') AND l.settled_by_loan_id IS NULL), (0)::numeric) AS amount_overdue,
    COALESCE(max(CURRENT_DATE - i.due_date) FILTER (WHERE i.due_date < CURRENT_DATE AND i.total_outstanding > (0)::numeric AND l.status IN ('active','pending_disbursement') AND l.settled_by_loan_id IS NULL), 0) AS days_past_due,
    min(i.due_date) FILTER (WHERE i.total_outstanding > (0)::numeric AND l.status IN ('active','pending_disbursement') AND l.settled_by_loan_id IS NULL) AS next_due_date
   FROM (mf_loans l
     LEFT JOIN mf_loan_installment_status i ON ((i.loan_id = l.id)))
  GROUP BY l.id;

-- A loan that has been replaced may never take another receipt.
CREATE OR REPLACE FUNCTION public.mf_loans_repayment_guard_settled(p_loan_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_succ text;
BEGIN
  SELECT s.loan_number INTO v_succ
    FROM public.mf_loans l
    JOIN public.mf_loans s ON s.id = l.settled_by_loan_id
   WHERE l.id = p_loan_id;
  IF v_succ IS NOT NULL THEN
    RAISE EXCEPTION 'This loan was replaced by loan %. Record the repayment against that loan instead.', v_succ;
  END IF;
END;
$$;
